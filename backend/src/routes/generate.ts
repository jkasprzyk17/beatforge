import { Router } from "express";
import fs from "node:fs";
import { analyseBeats } from "../services/beatDetection.js";
import {
  transcribeAudio,
  buildAssKaraoke,
  buildAssKaraokePill,
  buildAssSimple,
} from "../services/captions.js";
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
import {
  musicFile,
  clipFiles,
  previewPath,
  exportVideoPath,
  exportAssPath,
  thumbPath,
  newId,
  urlFor,
} from "../utils/helpers.js";
import {
  createJob,
  getJob,
  listJobs,
  updateJob,
  addOutput,
  deleteJob,
} from "../utils/jobs.js";
import { getAllHooks, getExportHistory } from "../utils/db.js";

export const generateRouter = Router();

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
    mood_id,
    duration_mode = "auto",
    custom_duration,
    batch_count = 1,
    segments: clientSegments,
    hook_id,
    seed,
  } = req.body as {
    music_id?: string;
    clips_id?: string;
    platforms?: string[];
    preset_id?: string;
    caption_color?: string;
    caption_active_color?: string;
    mood_id?: string;
    duration_mode?: "auto" | "custom";
    custom_duration?: number;
    batch_count?: number;
    segments?: { start: number; end: number; text: string }[];
    hook_id?: string;
    seed?: number; // 32-bit integer — makes renders reproducible
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

  // Seed default presets (idempotent)
  seedDefaultPresets();

  // Load preset — null = no preset, use defaults
  const preset = preset_id ? loadPreset(preset_id) : null;
  if (preset_id && !preset) {
    return res.status(404).json({ error: `Preset not found: ${preset_id}` });
  }

  // Resolve hook text (optional — omitting hook_id skips the text overlay)
  const hookText = hook_id
    ? getAllHooks().find((h) => h.id === hook_id)?.text
    : undefined;

  const job = createJob(newId());

  // Return job_id immediately — processing continues in background
  res.json({ job_id: job.id, status: "queued" });

  setImmediate(async () => {
    const totalVariants = batch_count * platforms.length;
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
        updateJob(job.id, { step: "Transkrypcja…", progress: 12 });
        segments = await transcribeAudio(mPath).catch(() => []);
        console.log(`[batch] ran Whisper (${segments.length} segments)`);
        updateJob(job.id, { step: "Montaż wideo…", progress: 30 });
      }

      let variant = 0;

      for (let v = 0; v < batch_count; v++) {
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
            "bold_center") as "bold_center" | "karaoke" | "karaoke_pill" | "minimal_clean";

          variant++;
          const vidPath = exportVideoPath(job.id, variant, platformId);
          const assPath = exportAssPath(job.id, variant);
          const tmbPath = thumbPath(job.id, variant);

          // ── Write .ass subtitle file ─────────────────────
          if (segments.length) {
            const boxBg      = preset?.config.captionBoxBackground ?? false;
            const wordsPerLn = preset?.config.captionWordsPerLine;

            let assContent: string;
            if (captionStyle === "karaoke_pill") {
              assContent = buildAssKaraokePill(segments, {
                width: profile.width,
                height: profile.height,
                color: resolvedColor,
                activeColor: resolvedActiveColor,
                marginBottom: profile.captionMarginBottom,
                bold: true,
                outline: 5,
                wordsPerLine: wordsPerLn,
                // pill has its own background — boxBg is intentionally not forwarded
              });
            } else if (captionStyle === "karaoke") {
              assContent = buildAssKaraoke(segments, {
                width: profile.width,
                height: profile.height,
                color: resolvedColor,
                activeColor: resolvedActiveColor,
                marginBottom: profile.captionMarginBottom,
                bold: true,
                outline: 5,
                wordsPerLine: wordsPerLn,
                boxBackground: boxBg,
              });
            } else {
              assContent = buildAssSimple(segments, {
                width: profile.width,
                height: profile.height,
                color: resolvedColor,
                style: captionStyle,
                marginBottom: profile.captionMarginBottom,
                wordsPerLine: wordsPerLn,
                boxBackground: boxBg,
              });
            }
            fs.writeFileSync(assPath, assContent, "utf8");
          }

          // Per-variant seed: each variant is distinct but deterministic.
          // Multiply v by a prime so seeds don't alias across batch_count=1 runs.
          const variantSeed = seed != null ? ((seed + v * 97) >>> 0) : undefined;

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
            hookText,
            hookAnimation: preset?.config.hookAnimation,
            seed: variantSeed,
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
  });
});
