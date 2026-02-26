import { Router } from "express";
import fs from "node:fs";
import { analyseBeats } from "../services/beatDetection.js";
import {
  transcribeAudio,
  buildAssKaraoke,
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

export const generateRouter = Router();

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
    res.json({ preview_url: urlFor(out), bpm: beats.bpm });
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
    mood_id,
    duration_mode = "auto",
    custom_duration,
    batch_count = 1,
    segments: clientSegments,
  } = req.body as {
    music_id?: string;
    clips_id?: string;
    platforms?: string[];
    preset_id?: string;
    caption_color?: string;
    mood_id?: string;
    duration_mode?: "auto" | "custom";
    custom_duration?: number;
    batch_count?: number;
    segments?: { start: number; end: number; text: string }[];
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

          // ── Resolve caption color ────────────────────────
          const resolvedColor = resolveCaptionColor(
            caption_color,
            preset,
            mood_id,
          );

          // ── Caption style ────────────────────────────────
          const captionStyle = (preset?.config.captionStyle ??
            "bold_center") as "bold_center" | "karaoke" | "minimal_clean";

          variant++;
          const vidPath = exportVideoPath(job.id, variant, platformId);
          const assPath = exportAssPath(job.id, variant);
          const tmbPath = thumbPath(job.id, variant);

          // ── Write .ass subtitle file ─────────────────────
          if (segments.length) {
            const assContent =
              captionStyle === "karaoke"
                ? buildAssKaraoke(segments, {
                    width: profile.width,
                    height: profile.height,
                    color: resolvedColor,
                    activeColor: "#FFFF00",
                    marginBottom: profile.captionMarginBottom,
                    bold: true,
                    outline: 5,
                  })
                : buildAssSimple(segments, {
                    width: profile.width,
                    height: profile.height,
                    color: resolvedColor,
                    style: captionStyle,
                    marginBottom: profile.captionMarginBottom,
                  });
            fs.writeFileSync(assPath, assContent, "utf8");
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
