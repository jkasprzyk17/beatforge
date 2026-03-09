/**
 * Mass Generation Engine — viral edit factory.
 *
 * Orchestrates the full pipeline for generating N unique edits from one audio track:
 *
 *   1.  Resolve paths      — IDs → filesystem paths
 *   2.  Beat analysis      — once per audio track (shared across all edits)
 *   3.  Transcription      — once per audio track (shared across all edits)
 *   4.  Build manifests    — all N manifests written to DB BEFORE any render starts
 *                            (crash-safe: incomplete jobs can be resumed)
 *   5.  Render loop        — N × P (platforms) renders, bounded by ffmpegQueue semaphore
 *   6.  Progress callback  — caller updates job progress in real-time
 *
 * PARALLELISM MODEL:
 *   All N×P render tasks are submitted to Promise.all() immediately.
 *   The ffmpegQueue semaphore ensures only MAX_FFMPEG_CONCURRENCY run at once.
 *   This is "bounded parallelism" — maximum throughput without resource exhaustion.
 *
 * DETERMINISM GUARANTEE:
 *   For any (masterSeed, editIndex, clipPool, hookPool):
 *     - selectedClips is always identical
 *     - hookText is always identical
 *     - ResolvedVariation is always identical
 *   Re-generating any edit from its manifest produces identical output.
 *
 * CLIP SELECTION (NO BIAS):
 *   Uses partial Fisher-Yates (sample()) — O(cutCount) not O(N).
 *   Each clip has equal probability of selection.
 *   No clip repeats within one edit (without-replacement sampling).
 *   Clips CAN repeat across different edits (allowed by spec).
 *
 * HOOK SELECTION:
 *   Hooks use pick() (uniform random with replacement).
 *   Same hook can appear in multiple edits — this is intentional per spec.
 */

import fs from "node:fs";
import path from "node:path";
import { mulberry32, deriveSeed, sample, pick } from "./prng.js";
import { createPackRotator, resolvePresetForEdit } from "./packRotation.js";
import {
  resolveVariation,
  mergeVariationIntoPreset,
  DEFAULT_VARIATION_POOL,
  type VariationPool,
  type ResolvedVariation,
} from "./variationEngine.js";
import { ffmpegQueue } from "./concurrencyQueue.js";
import {
  assembleVideo,
  getVideoDuration,
  extractThumbnail,
} from "./videoAssembler.js";
import { analyseBeats } from "./beatDetection.js";
import {
  transcribeAudio,
  buildAssKaraoke,
  buildAssKaraokePill,
  buildAssSimple,
} from "./captions.js";
import { PROFILES, type PlatformId } from "./platformProfiles.js";
import {
  loadPreset,
  resolveCaptionColor,
  resolveActiveColor,
  seedDefaultPresets,
} from "./presetService.js";
import { getFontFamily, type FontName } from "./fonts.js";
import {
  exportVideoPath,
  exportAssPath,
  thumbPath,
  urlFor,
} from "../utils/helpers.js";
import {
  updateJob,
  addOutput,
} from "../utils/jobs.js";
import {
  getAllCollections,
  getHookPackTexts,
  getStylePackPresetIds,
  getTranscription,
  saveTranscription,
  saveManifest,
  markManifestDone,
  markManifestFailed,
  type ManifestRecord,
} from "../utils/db.js";

// ── Public API ─────────────────────────────────────────────

export interface GenerateBatchOptions {
  jobId: string;
  audioPath: string;
  /** music_id / audio_id — do odczytu cache transkrypcji (bez tego za każdym razem Whisper) */
  musicId?: string;
  clipPaths: string[];
  hookTexts: string[];           // empty array = no hook overlay
  stylePackIds: string[];        // one or more; balanced round-robin applied
  presetIds: string[];           // parallel to stylePackIds (presetIds[i] ↔ stylePackIds[i])
  editCount: number;
  platforms: PlatformId[];
  seed?: number;                 // master seed; omit for clock-based seed
  variationPool?: Partial<VariationPool>;
  durationMode?: "auto" | "custom";
  customDuration?: number;
  clientSegments?: { start: number; end: number; text: string }[];
}

// ── Clip and hook resolution helpers ──────────────────────

/**
 * Resolve clip paths from a collection ID.
 * Throws if collection not found or contains no clips.
 */
export function resolveClipPaths(clipPackId: string): string[] {
  const collection = getAllCollections().find((c) => c.id === clipPackId);
  if (!collection) {
    throw new Error(`Clip pack not found: ${clipPackId}`);
  }
  const valid = collection.clipPaths.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (valid.length === 0) {
    throw new Error(`Clip pack "${collection.name}" contains no accessible clips`);
  }
  return valid;
}

/**
 * Resolve preset IDs for the given style pack IDs.
 * Each style pack maps to one or more presets — we take the first (primary) preset.
 * Falls back to the default preset if a pack has no presets configured.
 */
export function resolveStylePackPresets(
  stylePackIds: string[],
): string[] {
  return stylePackIds.map((packId) => {
    const presets = getStylePackPresetIds(packId);
    return presets[0] ?? "classic_clean_1"; // graceful fallback to built-in preset
  });
}

// ── Main generation function ───────────────────────────────

/**
 * Generate `editCount × platforms.length` video edits, bounded by ffmpegQueue.
 *
 * This function is designed to run in a background setImmediate/detached context.
 * It calls `updateJob()` at key milestones — callers watch the job via SSE.
 *
 * CRASH SAFETY:
 *   Manifests are saved to the database BEFORE any FFmpeg process is spawned.
 *   If the server crashes mid-batch, the caller can query generation_manifests
 *   WHERE status='pending' AND job_id=? to resume from where it left off.
 */
export async function generateBatch(opts: GenerateBatchOptions): Promise<void> {
  const {
    jobId,
    audioPath,
    clipPaths,
    hookTexts,
    stylePackIds,
    presetIds,
    editCount,
    platforms,
    seed,
    variationPool: poolOverride,
    durationMode = "auto",
    customDuration,
    clientSegments,
  } = opts;
  const musicId = opts.musicId;

  seedDefaultPresets();

  const pool: VariationPool = { ...DEFAULT_VARIATION_POOL, ...poolOverride };
  const totalVariants = editCount * platforms.length;

  // ── Master seed ───────────────────────────────────────────
  // If no seed provided, derive one from current time.
  // The master seed is logged in each manifest so the batch is always reproducible.
  const masterSeed: number =
    seed !== undefined ? seed >>> 0 : (Date.now() & 0xffffffff) >>> 0;

  // ── Pack rotator ──────────────────────────────────────────
  const rotator = createPackRotator(stylePackIds);

  // ── Phase 1: Beat analysis ────────────────────────────────
  updateJob(jobId, { step: "Analiza beatów…", progress: 3 });
  const beats = await analyseBeats(audioPath);
  const trackDuration = await getVideoDuration(audioPath);
  if (trackDuration <= 0) throw new Error("Could not read track duration");

  // ── Phase 2: Transcription (cache first — nie odpalać Whisper za każdym razem) ──
  let segments: { start: number; end: number; text: string }[];
  if (clientSegments && clientSegments.length > 0) {
    segments = clientSegments;
    updateJob(jobId, {
      step: "Montaż wideo…",
      progress: 20,
      phases_skipped: ["transcription"],
    });
  } else if (musicId) {
    const cached = getTranscription(musicId);
    if (cached?.segments?.length) {
      segments = cached.segments;
      console.log(`[mass-generate] cache hit for ${musicId} (${segments.length} segments) — skipping Whisper`);
      updateJob(jobId, { step: "Montaż wideo…", progress: 20 });
    } else {
      updateJob(jobId, { step: "Transkrypcja…", progress: 12 });
      segments = await transcribeAudio(audioPath).catch(() => []);
      if (segments.length > 0) {
        const fullText = segments.map((s) => s.text).join(" ");
        saveTranscription({
          musicId,
          segments,
          fullText,
          duration: trackDuration,
          createdAt: new Date().toISOString(),
        });
        console.log(`[mass-generate] ran Whisper (${segments.length} segments), saved to cache`);
      }
      updateJob(jobId, { step: "Montaż wideo…", progress: 30 });
    }
  } else {
    updateJob(jobId, { step: "Transkrypcja…", progress: 12 });
    segments = await transcribeAudio(audioPath).catch(() => []);
    if (segments.length > 0) {
      console.log(`[mass-generate] ran Whisper (${segments.length} segments), no musicId — not cached`);
    }
    updateJob(jobId, { step: "Montaż wideo…", progress: 30 });
  }

  // ── Phase 3: Build all manifests upfront (crash-safe) ────
  //
  // All edit decisions (clip selection, hook, variation) are materialised
  // and persisted before any FFmpeg process starts.
  // If the server crashes after saving manifests but before finishing renders,
  // a recovery pass can query pending manifests and re-render them.
  const manifests: ManifestRecord[] = [];

  for (let editIdx = 0; editIdx < editCount; editIdx++) {
    // Per-edit seed: derived from master seed + edit index.
    // deriveSeed() uses splitmix32 avalanche to break correlation between
    // consecutive indices — edit 0 and edit 1 produce uncorrelated sequences.
    const editSeed = deriveSeed(masterSeed, editIdx);
    const rng = mulberry32(editSeed);

    // Style pack + preset for this edit (balanced rotation)
    const stylePackId = rotator.resolve(editIdx);
    const presetId = resolvePresetForEdit(presetIds, editIdx, stylePackIds.length);

    // Resolve variation using the edit's RNG — fully deterministic
    const variation = resolveVariation(pool, rng, clipPaths.length);

    // Clip selection: partial Fisher-Yates from the full pool.
    // cutCount clips selected without replacement (no clip repeats within edit).
    const selectedClips = sample(clipPaths, variation.cutCount, rng);

    // Hook selection: uniform random with replacement (hooks CAN repeat).
    const hookText =
      hookTexts.length > 0 ? pick(hookTexts, rng) : undefined;

    const manifest: ManifestRecord = {
      id: `${jobId}_e${editIdx.toString().padStart(5, "0")}`,
      jobId,
      editIndex: editIdx,
      seed: editSeed,
      masterSeed,
      audioPath,
      stylePackId,
      presetId,
      selectedClips,
      hookText: hookText ?? null,
      variationJson: JSON.stringify(variation),
      status: "pending",
      createdAt: Date.now(),
    };

    manifests.push(manifest);
    saveManifest(manifest); // persisted to DB before any render
  }

  // ── Phase 4: Render all edits (bounded parallelism) ───────
  //
  // All P × editCount tasks are submitted simultaneously to Promise.all().
  // The ffmpegQueue semaphore ensures only MAX_FFMPEG_CONCURRENCY run at once.
  // Completed tasks immediately release their slot, unblocking waiting tasks.
  let doneVariants = 0;
  updateJob(jobId, { total_variants: totalVariants, done_variants: 0 });

  const renderTasks: Promise<void>[] = [];

  for (let editIdx = 0; editIdx < editCount; editIdx++) {
    const manifest = manifests[editIdx]!;

    for (let pIdx = 0; pIdx < platforms.length; pIdx++) {
      const platformId = platforms[pIdx]!;
      // variant is 1-based (matches existing job_outputs schema)
      const variant = editIdx * platforms.length + pIdx + 1;

      const task = ffmpegQueue.run(async () => {
        try {
          await renderSingleEdit({
            jobId,
            manifest,
            variant,
            platformId,
            beats,
            trackDuration,
            segments,
            durationMode,
            customDuration,
          });

          markManifestDone(manifest.id);

          // Record output in job_outputs
          const vidPath = exportVideoPath(jobId, variant, platformId);
          const assPath = exportAssPath(jobId, variant);
          const tmbPath = thumbPath(jobId, variant);
          const variation = JSON.parse(manifest.variationJson) as ResolvedVariation;

          addOutput(jobId, {
            variant,
            platform: platformId,
            style: variation.lyricStyle,
            preset_id: manifest.presetId,
            final_duration: resolveTargetDuration(
              trackDuration,
              durationMode,
              customDuration,
              PROFILES[platformId] ?? PROFILES.tiktok,
            ),
            video_url: urlFor(vidPath),
            caption_url: fs.existsSync(assPath) ? urlFor(assPath) : "",
            thumb_url: fs.existsSync(tmbPath) ? urlFor(tmbPath) : undefined,
          });
        } catch (err) {
          markManifestFailed(manifest.id, (err as Error).message);
          // Non-fatal: log the error but continue the batch.
          // One failing edit should not abort 999 others.
          console.error(`[massGen] edit ${editIdx} variant ${variant} failed:`, err);
        }

        doneVariants++;
        const progress = Math.round(30 + (doneVariants / totalVariants) * 67);
        updateJob(jobId, {
          progress,
          done_variants: doneVariants,
          step:
            doneVariants < totalVariants
              ? `Montaż wideo… (${doneVariants}/${totalVariants})`
              : "Finalizuję…",
        });
      });

      renderTasks.push(task);
    }
  }

  // Await all renders (parallelism already bounded by semaphore)
  await Promise.all(renderTasks);
}

// ── Single-edit render ─────────────────────────────────────

interface RenderArgs {
  jobId: string;
  manifest: ManifestRecord;
  variant: number;
  platformId: PlatformId;
  beats: Awaited<ReturnType<typeof analyseBeats>>;
  trackDuration: number;
  segments: { start: number; end: number; text: string }[];
  durationMode: "auto" | "custom";
  customDuration?: number;
}

async function renderSingleEdit(args: RenderArgs): Promise<void> {
  const {
    jobId,
    manifest,
    variant,
    platformId,
    beats,
    trackDuration,
    segments,
    durationMode,
    customDuration,
  } = args;

  const variation = JSON.parse(manifest.variationJson) as ResolvedVariation;
  const profile = PROFILES[platformId] ?? PROFILES.tiktok;
  const preset = manifest.presetId ? loadPreset(manifest.presetId) : null;

  // ── Duration resolution ───────────────────────────────────
  const finalDuration = resolveTargetDuration(
    trackDuration,
    durationMode,
    customDuration,
    profile,
    preset?.config.maxDuration,
  );

  // ── Output paths ──────────────────────────────────────────
  const vidPath = exportVideoPath(jobId, variant, platformId);
  const assPath = exportAssPath(jobId, variant);
  const tmbPath = thumbPath(jobId, variant);

  // ── Caption style: variation overrides preset ─────────────
  const captionStyle = (
    preset?.config.captionStyle ?? variation.lyricStyle
  ) as "bold_center" | "karaoke" | "karaoke_pill" | "minimal_clean";

  const resolvedColor = resolveCaptionColor(undefined, preset, undefined);
  const resolvedActiveColor = resolveActiveColor(undefined, preset);
  const fontFamily = getFontFamily(
    (preset?.config.captionFont ?? "arial") as FontName,
  );
  const wordsPerLine = preset?.config.captionWordsPerLine;
  const boxBackground =
    variation.captionBoxBackground || (preset?.config.captionBoxBackground ?? false);
  const displayMode = preset?.config.captionDisplayMode;
  const captionPosition = preset?.config.captionPosition;

  // ── Write .ass subtitle file ──────────────────────────────
  if (segments.length > 0) {
    let assContent: string;

    const outline = preset?.config.captionOutline ?? 5;
    const shadow = preset?.config.captionShadow;
    const spacing = preset?.config.captionSpacing;
    const fontSize = preset?.config.captionFontSize;
    const captionAnim = preset?.config.captionAnimation;
    const authorLabel = preset?.config.authorLabel;

    if (captionStyle === "karaoke_pill") {
      assContent = buildAssKaraokePill(segments, {
        width: profile.width,
        height: profile.height,
        color: resolvedColor,
        activeColor: resolvedActiveColor,
        marginBottom: profile.captionMarginBottom,
        bold: true,
        outline,
        shadow,
        spacing,
        fontSize,
        wordsPerLine,
        position: captionPosition,
        fontFamily,
        captionAnimation: captionAnim,
        authorLabel,
        durationSeconds: authorLabel ? finalDuration : undefined,
      });
    } else if (captionStyle === "karaoke") {
      assContent = buildAssKaraoke(segments, {
        width: profile.width,
        height: profile.height,
        color: resolvedColor,
        activeColor: resolvedActiveColor,
        marginBottom: profile.captionMarginBottom,
        bold: true,
        outline,
        shadow,
        spacing,
        fontSize,
        wordsPerLine,
        displayMode,
        position: captionPosition,
        boxBackground,
        fontFamily,
        captionAnimation: captionAnim,
        authorLabel,
        durationSeconds: authorLabel ? finalDuration : undefined,
      });
    } else {
      assContent = buildAssSimple(segments, {
        width: profile.width,
        height: profile.height,
        color: resolvedColor,
        style: captionStyle,
        marginBottom: profile.captionMarginBottom,
        wordsPerLine,
        displayMode,
        position: captionPosition,
        boxBackground,
        fontFamily,
        captionAnimation: captionAnim,
        outline: preset?.config.captionOutline,
        shadow,
        spacing,
        fontSize,
        authorLabel,
        durationSeconds: authorLabel ? finalDuration : undefined,
      });
    }

    fs.mkdirSync(path.dirname(assPath), { recursive: true });
    fs.writeFileSync(assPath, assContent, "utf8");
  }

  // ── Merge variation into preset config ────────────────────
  // mergeVariationIntoPreset() overlays variation-resolved values on top of
  // the preset config. Variation wins except for captionStyle (preset wins).
  const mergedConfig = mergeVariationIntoPreset(
    preset?.config as unknown as Record<string, unknown> ?? null,
    variation,
  );

  // ── Assemble video ────────────────────────────────────────
  await assembleVideo({
    jobId,
    variant,
    clipPaths: manifest.selectedClips, // pre-selected by massGenerator
    musicPath: manifest.audioPath,
    beats,
    profile,
    finalDuration,
    preset: mergedConfig as unknown as Parameters<typeof assembleVideo>[0]["preset"],
    segments: segments.length > 0 ? segments : undefined,
    captionColor: resolvedColor,
    outputPath: vidPath,
    captionPath: assPath,
    captionsAsLayer: mergedConfig.captionsAsLayer ?? false,
    hookText: manifest.hookText ?? undefined,
    hookAnimation: preset?.config.hookAnimation,
    seed: manifest.seed,
  });

  await extractThumbnail(vidPath, tmbPath).catch(() => {});
}

// ── Duration resolution helper ────────────────────────────

function resolveTargetDuration(
  trackDuration: number,
  durationMode: "auto" | "custom",
  customDuration: number | undefined,
  profile: { maxDuration: number },
  presetMaxDuration?: number,
): number {
  let d: number;

  if (durationMode === "custom" && customDuration && customDuration > 0) {
    d = Math.min(customDuration, trackDuration);
  } else {
    d = Math.min(trackDuration, profile.maxDuration);
  }

  if (presetMaxDuration) {
    d = Math.min(d, presetMaxDuration);
  }

  return Math.max(1, Math.floor(d));
}
