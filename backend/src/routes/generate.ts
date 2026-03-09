import { Router } from "express";
import fs from "node:fs";
import { analyseBeats } from "../services/beatDetection.js";
import {
  transcribeAudio,
  buildAssKaraoke,
  buildAssKaraokePill,
  buildAssSimple,
  type CaptionAnimation,
} from "../services/captions.js";
import {
  generateAssSubtitles,
  type WordTimestamp,
} from "../services/karaokeSubtitles.js";
import {
  assembleVideo,
  assemblePreview,
  extractThumbnail,
  getVideoDuration,
} from "../services/videoAssembler.js";
import { PROFILES, type PlatformId } from "../services/platformProfiles.js";
import {
  loadPreset,
  resolveCaptionColor,
  resolveActiveColor,
  seedDefaultPresets,
} from "../services/presetService.js";
import { getFontFamily, type FontName } from "../services/fonts.js";
import path from "node:path";
import {
  musicFile,
  clipFiles,
  previewPath,
  exportVideoPath,
  exportAssPath,
  thumbPath,
  newId,
  urlFor,
  packNameToSlug,
  ensureExportDir,
} from "../utils/helpers.js";
import {
  createJob,
  getJob,
  listJobs,
  updateJob,
  addOutput,
  deleteJob,
} from "../utils/jobs.js";
import { getAllHooks, getExportHistory, getTranscription, saveTranscription } from "../utils/db.js";
import { ffmpegQueue, MAX_CONCURRENT } from "../utils/queue.js";
import type { Composition } from "../types/composition.js";

export const generateRouter = Router();

// ── GET /api/queue ────────────────────────────────────────
// Returns the current concurrency-queue status so the frontend can show
// a "waiting in queue" message when the server is busy.

generateRouter.get("/queue", (_req, res) => {
  res.json({
    active:        ffmpegQueue.active,
    pending:       ffmpegQueue.pending,
    maxConcurrent: MAX_CONCURRENT,
  });
});

// ── GET /api/exports ──────────────────────────────────────
// Flat list of all completed export outputs, newest first.
// Unlike /api/jobs (which includes in-progress state), this endpoint is
// purely about finished, downloadable files.

generateRouter.get("/exports", (_req, res) => {
  res.json(getExportHistory());
});

// ── GET /api/platforms ────────────────────────────────────

generateRouter.get("/platforms", (_req, res) => {
  res.json(
    Object.values(PROFILES).map((p) => ({
      id: p.id,
      label: p.label,
      emoji: p.emoji,
      width: p.width,
      height: p.height,
      maxDuration: p.maxDuration,
      defaultDuration: p.defaultDuration,
    })),
  );
});

// ── GET /api/jobs ─────────────────────────────────────────

generateRouter.get("/jobs", (_req, res) => {
  res.json(listJobs());
});

// ── GET /api/jobs/:id ─────────────────────────────────────

generateRouter.get("/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ── GET /api/jobs/:id/stream  (SSE) ──────────────────────
// Pushes job state to the client every 800 ms until done/error.
// The client just opens an EventSource — no more polling.

generateRouter.get("/jobs/:id/stream", (req, res) => {
  const { id } = req.params;

  // Verify the job exists before holding the connection open
  if (!getJob(id)) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Disable nginx / proxy buffering so events arrive immediately
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = () => {
    const job = getJob(id);
    if (!job) {
      res.write("event: error\ndata: {\"error\":\"Job not found\"}\n\n");
      clearInterval(timer);
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    if (job.status === "done" || job.status === "error") {
      clearInterval(timer);
      res.end();
    }
  };

  // Send current state immediately, then push every 800 ms
  send();
  const timer = setInterval(send, 800);

  // Client disconnected — stop the timer
  req.on("close", () => clearInterval(timer));
});

// ── DELETE /api/jobs/:id ──────────────────────────────────

generateRouter.delete("/jobs/:id", (req, res) => {
  const deleted = deleteJob(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Job not found" });
  res.json({ ok: true });
});

// ── POST /api/generate-preview ────────────────────────────

generateRouter.post("/generate-preview", async (req, res) => {
  const {
    music_id,
    clips_id,
    preview_duration = 5,
  } = req.body as {
    music_id?: string;
    clips_id?: string;
    preview_duration?: number;
  };

  if (!music_id || !clips_id)
    return res.status(400).json({ error: "music_id and clips_id required" });

  let mPath: string, cPaths: string[];
  try {
    mPath = musicFile(music_id);
    cPaths = clipFiles(clips_id);
  } catch (e: unknown) {
    return res.status(404).json({ error: (e as Error).message });
  }

  const jobId = newId();
  const out = previewPath(jobId);

  try {
    const beats = await analyseBeats(mPath);
    await assemblePreview(cPaths, mPath, beats, preview_duration, out);
    res.json({ preview_url: urlFor(out), bpm: beats.bpm, beats: beats.beats });
  } catch (e: unknown) {
    console.error("[preview]", e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── POST /api/generate-batch ──────────────────────────────

generateRouter.post("/generate-batch", async (req, res) => {
  const {
    music_id,
    clips_id,
    platforms = ["tiktok"],
    preset_id,
    caption_color,
    caption_active_color,
    caption_font,
    caption_animation,
    caption_display_mode,
    caption_position,
    mood_id,
    duration_mode = "auto",
    custom_duration,
    batch_count = 1,
    segments: clientSegments,
    hook_id,
    hook_folder_id,
    seed,
    composition,
    pack_name,
    captions_as_layer,
    author_label,
  } = req.body as {
    music_id?: string;
    clips_id?: string;
    platforms?: string[];
    preset_id?: string;
    caption_color?: string;
    caption_active_color?: string;
    caption_font?: string;       // FontName override — "impact" | "oswald" | "montserrat" | "arial"
    caption_animation?: string;  // CaptionAnimation override — "pop" | "bounce" | "fade" | "none"
    caption_display_mode?: "1_word" | "2_words" | "3_words" | "1_line" | "2_lines" | "3_lines";
    caption_position?: "center" | "bottom"; // środek | na dole
    mood_id?: string;
    duration_mode?: "auto" | "custom";
    custom_duration?: number;
    batch_count?: number;
    segments?: { start: number; end: number; text: string }[];
    hook_id?: string;
    hook_folder_id?: string;     // mood id — losowy hook z tego folderu na każdy wariant
    seed?: number; // 32-bit integer — makes renders reproducible
    composition?: { id: string; audioId: string; aspectRatio: string; resizeMode: string; outputDisplayMode?: string; seed?: number; layers: object[] };
    captions_as_layer?: boolean; // napisy jako warstwa (osobny .ass) zamiast wypalania w wideo
    pack_name?: string;         // nazwa paczki mixów → exports/pack_slug/
    author_label?: string;      // creator name at top (e.g. "Dominik Łupicki")
  };

  if (!music_id || !clips_id)
    return res.status(400).json({ error: "music_id and clips_id required" });

  const batchCount = Math.min(100, Math.max(1, Number(batch_count) || 1));
  const packSlug = pack_name ? packNameToSlug(pack_name) : undefined;
  if (packSlug) ensureExportDir(packSlug);

  let mPath: string, cPaths: string[];
  try {
    mPath = musicFile(music_id);
    cPaths = clipFiles(clips_id);
  } catch (e: unknown) {
    return res.status(404).json({ error: (e as Error).message });
  }

  // Seed default presets (idempotent)
  seedDefaultPresets();

  // Load preset — null = no preset, use defaults
  const preset = preset_id ? loadPreset(preset_id) : null;
  if (preset_id && !preset) {
    return res.status(404).json({ error: `Preset not found: ${preset_id}` });
  }

  // Hook text: single hook (hook_id) or random from folder per variant (hook_folder_id)
  const singleHookText =
    hook_id && !hook_folder_id
      ? getAllHooks().find((h) => h.id === hook_id)?.text
      : undefined;
  const folderHooks =
    hook_folder_id
      ? getAllHooks().filter((h) => (h.moodId ?? "") === hook_folder_id)
      : [];
  // Deterministic RNG for folder pick (mulberry32)
  const nextRng = (s: number) => {
    let t = (s + 0x6d2b79f5) | 0;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const job = createJob(newId());

  // Return job_id immediately — processing continues in background.
  // The job stays "queued" until the ffmpegQueue has a free slot (max 2 parallel
  // FFmpeg pipelines).  Once a slot opens the status flips to "processing".
  res.json({ job_id: job.id, status: "queued" });

  setImmediate(() => {
    void ffmpegQueue.run(async () => {
    const totalVariants = batchCount * platforms.length;
    updateJob(job.id, {
      status: "processing",
      step: "Analiza beatów…",
      progress: 3,
      total_variants: totalVariants,
      done_variants: 0,
    });
    try {
      // ── Resolve track duration via ffprobe ───────────────
      const trackDuration = await getVideoDuration(mPath);
      if (trackDuration <= 0) throw new Error("Could not read track duration");

      // ── Beat analysis ────────────────────────────────────
      const beats = await analyseBeats(mPath);

      // ── Transcription ────────────────────────────────────
      let segments: { start: number; end: number; text: string }[];
      if (clientSegments && clientSegments.length > 0) {
        segments = clientSegments;
        console.log(`[batch] using ${segments.length} client-provided segments — skipping Whisper`);
        updateJob(job.id, {
          step: "Montaż wideo…",
          progress: 20,
          phases_skipped: ["transcription"],
        });
      } else {
        const cached = getTranscription(music_id);
        if (cached?.segments?.length) {
          segments = cached.segments;
          console.log(`[batch] cache hit for ${music_id} (${segments.length} segments) — skipping Whisper`);
          updateJob(job.id, { step: "Montaż wideo…", progress: 20 });
        } else {
          console.log(`[batch] no client segments, cache ${cached ? "empty" : "miss"} for ${music_id} — running Whisper`);
          updateJob(job.id, { step: "Transkrypcja…", progress: 12 });
          segments = await transcribeAudio(mPath).catch((err) => {
            console.warn("[batch] Whisper failed, no captions:", (err as Error)?.message ?? err);
            return [];
          });
          if (segments.length > 0) {
            const fullText = segments.map((s) => s.text).join(" ");
            saveTranscription({
              musicId: music_id,
              segments,
              fullText,
              duration: trackDuration,
              createdAt: new Date().toISOString(),
            });
            console.log(`[batch] ran Whisper (${segments.length} segments), saved to cache`);
          } else {
            console.warn("[batch] No caption segments — transkrypcja pusta lub nieudana; wideo bez napisów.");
          }
          updateJob(job.id, { step: "Montaż wideo…", progress: 30 });
        }
      }

      let variant = 0;

      for (let v = 0; v < batchCount; v++) {
        for (const platformId of platforms) {
          const profile = PROFILES[platformId as PlatformId] ?? PROFILES.tiktok;

          // ── Resolve final duration ───────────────────────
          let finalDuration: number;

          if (
            duration_mode === "custom" &&
            custom_duration &&
            custom_duration > 0
          ) {
            finalDuration = Math.min(custom_duration, trackDuration);
          } else {
            finalDuration = Math.min(trackDuration, profile.maxDuration);
          }

          // Preset max duration override
          if (preset?.config.maxDuration) {
            finalDuration = Math.min(finalDuration, preset.config.maxDuration);
          }

          finalDuration = Math.max(1, Math.floor(finalDuration));

          // ── Resolve caption colors ───────────────────────
          const resolvedColor = resolveCaptionColor(
            caption_color,
            preset,
            mood_id,
          );
          const resolvedActiveColor = resolveActiveColor(
            caption_active_color,
            preset,
          );

          // ── Caption style ────────────────────────────────
          const captionStyle = (preset?.config.captionStyle ??
            "bold_center") as "bold_center" | "karaoke" | "karaoke_pill" | "karaoke_simple" | "minimal_clean";

          // ── Caption font ─────────────────────────────────
          // Priority: explicit request param > preset captionFont > "arial" fallback
          const resolvedFontName = (
            caption_font ?? preset?.config.captionFont ?? "arial"
          ) as FontName;
          const fontFamily = getFontFamily(resolvedFontName);

          // ── Caption animation ─────────────────────────────
          // Priority: explicit request param > preset captionAnimation > "none"
          const resolvedCaptionAnim = (
            caption_animation ?? preset?.config.captionAnimation ?? "none"
          ) as CaptionAnimation;

          variant++;
          const vidPath = exportVideoPath(job.id, variant, platformId, packSlug);
          const assPath = exportAssPath(job.id, variant, packSlug);
          const tmbPath = thumbPath(job.id, variant);

          // ── Write .ass subtitle file ─────────────────────
          if (segments.length) {
            fs.mkdirSync(path.dirname(assPath), { recursive: true });
            const boxBg      = preset?.config.captionBoxBackground ?? false;
            const wordsPerLn = preset?.config.captionWordsPerLine;
            const displayMode = (caption_display_mode ??
              preset?.config.captionDisplayMode) as
              | "1_word"
              | "2_words"
              | "3_words"
              | "1_line"
              | "2_lines"
              | "3_lines"
              | undefined;
            const captionPosition = (caption_position ??
              preset?.config.captionPosition) as "center" | "bottom" | undefined;

            const authorLabel = author_label ?? preset?.config.authorLabel;

            let assContent: string | undefined;
            if (captionStyle === "karaoke_simple") {
              const words: WordTimestamp[] = segments.map((s) => ({
                word: s.text,
                start: s.start,
                end: s.end,
              }));
              await generateAssSubtitles(words, assPath);
            } else if (captionStyle === "karaoke_pill") {
              assContent = buildAssKaraokePill(segments, {
                width: profile.width,
                height: profile.height,
                color: resolvedColor,
                activeColor: resolvedActiveColor,
                marginBottom: profile.captionMarginBottom,
                bold: true,
                outline: preset?.config.captionOutline ?? 5,
                shadow: preset?.config.captionShadow,
                spacing: preset?.config.captionSpacing,
                fontSize: preset?.config.captionFontSize,
                wordsPerLine: wordsPerLn,
                position: captionPosition,
                fontFamily,
                captionAnimation: resolvedCaptionAnim,
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
                outline: preset?.config.captionOutline ?? 5,
                shadow: preset?.config.captionShadow,
                spacing: preset?.config.captionSpacing,
                fontSize: preset?.config.captionFontSize,
                wordsPerLine: wordsPerLn,
                displayMode,
                position: captionPosition,
                boxBackground: boxBg,
                fontFamily,
                captionAnimation: resolvedCaptionAnim,
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
                wordsPerLine: wordsPerLn,
                displayMode,
                position: captionPosition,
                boxBackground: boxBg,
                fontFamily,
                captionAnimation: resolvedCaptionAnim,
                outline: preset?.config.captionOutline,
                shadow: preset?.config.captionShadow,
                spacing: preset?.config.captionSpacing,
                fontSize: preset?.config.captionFontSize,
                authorLabel,
                durationSeconds: authorLabel ? finalDuration : undefined,
              });
            }
            if (assContent !== undefined) {
              fs.writeFileSync(assPath, assContent, "utf8");
            }
          }

          // Per-variant seed: each variant is distinct but deterministic.
          const variantSeed = seed != null ? ((seed + v * 97) >>> 0) : undefined;
          // Hook text: single hook for all, or random from folder per variant
          let hookText: string | undefined = singleHookText;
          if (hook_folder_id && folderHooks.length > 0) {
            const state = ((variantSeed ?? 0) + v * 7919) >>> 0;
            const idx = Math.floor(nextRng(state) * folderHooks.length);
            hookText = folderHooks[idx]?.text;
          }

          // ── Assemble video ───────────────────────────────
          await assembleVideo({
            jobId: job.id,
            variant,
            clipPaths: cPaths,
            musicPath: mPath,
            beats,
            profile,
            finalDuration,
            preset: preset?.config ?? null,
            segments: segments.length ? segments : undefined,
            captionColor: resolvedColor,
            outputPath: vidPath,
            captionPath: assPath,
            captionsAsLayer: captions_as_layer ?? preset?.config.captionsAsLayer ?? false,
            hookText,
            hookAnimation: preset?.config.hookAnimation,
            seed: variantSeed,
            composition: composition as Composition | undefined,
          });

          await extractThumbnail(vidPath, tmbPath).catch(() => {});

          addOutput(job.id, {
            variant,
            platform: platformId,
            style: captionStyle,
            preset_id: preset_id ?? null,
            final_duration: finalDuration,
            video_url: urlFor(vidPath),
            caption_url: fs.existsSync(assPath) ? urlFor(assPath) : "",
            thumb_url: fs.existsSync(tmbPath) ? urlFor(tmbPath) : undefined,
          });

          // Update per-variant progress (30–97 range distributed across variants)
          const doneNow = variant;
          const variantProgress = Math.round(30 + (doneNow / totalVariants) * 67);
          const remaining = totalVariants - doneNow;
          updateJob(job.id, {
            step: remaining > 0
              ? `Montaż wideo… (${doneNow}/${totalVariants})`
              : "Finalizuję…",
            progress: variantProgress,
            done_variants: doneNow,
          });
        }
      }

      updateJob(job.id, { status: "done", step: "Gotowe", progress: 100 });
    } catch (err: unknown) {
      console.error("[batch]", err);
      updateJob(job.id, { status: "error", error: (err as Error).message });
    }
    }); // ffmpegQueue.run
  });
});
