/**
 * POST /api/mass-generate
 *
 * Mass video generation endpoint.
 * Accepts a rich batch request referencing pack IDs and returns a job_id
 * immediately. Processing continues in the background.
 *
 * Request body (JSON):
 * {
 *   "audio_id":        "track-uuid",              // required
 *   "clip_pack_id":    "collection-uuid",          // required
 *   "hook_pack_id":    "hookpack-uuid" | null,     // optional
 *   "style_pack_ids":  ["packA", "packB"],         // required, ≥1
 *   "edit_count":      100,                        // required, 1–10000
 *   "platforms":       ["tiktok", "reels"],        // default: ["tiktok"]
 *   "seed":            42,                         // optional uint32
 *   "duration_mode":   "auto" | "custom",          // default: "auto"
 *   "custom_duration": 20,                         // seconds, only for "custom"
 *   "segments":        [...],                      // optional pre-built transcription
 *   "variation_pool":  { ... }                     // optional partial VariationPool override
 * }
 *
 * Response:
 * {
 *   "job_id": "...",
 *   "status": "queued",
 *   "edit_count": 100,
 *   "total_variants": 100,
 *   "master_seed": 42
 * }
 *
 * Example payload (100 edits, 2 style packs, seeded):
 * {
 *   "audio_id": "abc123",
 *   "clip_pack_id": "clips_hype",
 *   "hook_pack_id": "hooks_motivation",
 *   "style_pack_ids": ["pack_dominant", "pack_ekipa"],
 *   "edit_count": 100,
 *   "platforms": ["tiktok"],
 *   "seed": 2024,
 *   "variation_pool": {
 *     "cutCountRange": [4, 6],
 *     "zoomPunchStrengthRange": [1.05, 1.10],
 *     "glitchProbability": 0.7,
 *     "speedVarianceProbability": 0.4
 *   }
 * }
 */

import { Router } from "express";
import { musicFile, newId } from "../utils/helpers.js";
import { createJob, updateJob } from "../utils/jobs.js";
import {
  getHookPackTexts,
  getStylePackPresetIds,
} from "../utils/db.js";
import {
  resolveClipPaths,
  resolveStylePackPresets,
  generateBatch,
  type GenerateBatchOptions,
} from "../services/massGenerator.js";
import { type PlatformId, PROFILES } from "../services/platformProfiles.js";
import { DEFAULT_VARIATION_POOL, type VariationPool } from "../services/variationEngine.js";
import { ffmpegQueue } from "../services/concurrencyQueue.js";

export const massGenerateRouter = Router();

// ── POST /api/mass-generate ───────────────────────────────

massGenerateRouter.post("/mass-generate", async (req, res) => {
  const {
    audio_id,
    clip_pack_id,
    hook_pack_id,
    style_pack_ids,
    edit_count = 1,
    platforms = ["tiktok"],
    seed,
    duration_mode = "auto",
    custom_duration,
    segments: clientSegments,
    variation_pool,
  } = req.body as {
    audio_id?: string;
    clip_pack_id?: string;
    hook_pack_id?: string | null;
    style_pack_ids?: string[];
    edit_count?: number;
    platforms?: string[];
    seed?: number;
    duration_mode?: "auto" | "custom";
    custom_duration?: number;
    segments?: { start: number; end: number; text: string }[];
    variation_pool?: Partial<VariationPool>;
  };

  // ── Validate required fields ────────────────────────────
  if (!audio_id) {
    return res.status(400).json({ error: "audio_id is required" });
  }
  if (!clip_pack_id) {
    return res.status(400).json({ error: "clip_pack_id is required" });
  }
  if (!style_pack_ids || style_pack_ids.length === 0) {
    return res.status(400).json({ error: "style_pack_ids must be a non-empty array" });
  }
  if (edit_count < 1 || edit_count > 10_000) {
    return res.status(400).json({ error: "edit_count must be between 1 and 10000" });
  }

  // ── Validate platform IDs ────────────────────────────────
  const validPlatformIds = Object.keys(PROFILES) as PlatformId[];
  const resolvedPlatforms = platforms.filter((p) =>
    validPlatformIds.includes(p as PlatformId),
  ) as PlatformId[];
  if (resolvedPlatforms.length === 0) {
    return res.status(400).json({ error: `Invalid platform IDs: ${platforms.join(", ")}` });
  }

  // ── Resolve audio path ───────────────────────────────────
  let audioPath: string;
  try {
    audioPath = musicFile(audio_id);
  } catch (e) {
    return res.status(404).json({ error: (e as Error).message });
  }

  // ── Resolve clip paths ───────────────────────────────────
  let clipPaths: string[];
  try {
    clipPaths = resolveClipPaths(clip_pack_id);
  } catch (e) {
    return res.status(404).json({ error: (e as Error).message });
  }

  // ── Resolve hook texts ───────────────────────────────────
  const hookTexts: string[] = hook_pack_id
    ? getHookPackTexts(hook_pack_id)
    : [];

  // ── Resolve preset IDs per style pack ───────────────────
  let presetIds: string[];
  try {
    presetIds = resolveStylePackPresets(style_pack_ids);
  } catch (e) {
    return res.status(404).json({ error: (e as Error).message });
  }

  // ── Determine master seed for response metadata ──────────
  const masterSeed: number =
    seed !== undefined ? seed >>> 0 : (Date.now() & 0xffffffff) >>> 0;

  // ── Create job ───────────────────────────────────────────
  const job = createJob(newId());
  const totalVariants = edit_count * resolvedPlatforms.length;

  updateJob(job.id, {
    status: "processing",
    total_variants: totalVariants,
    done_variants: 0,
    step: "Inicjalizacja…",
    progress: 1,
  });

  // ── Return immediately — processing in background ────────
  res.json({
    job_id: job.id,
    status: "queued",
    edit_count,
    total_variants: totalVariants,
    master_seed: masterSeed,
    queue_status: ffmpegQueue.status(),
  });

  setImmediate(async () => {
    try {
      const opts: GenerateBatchOptions = {
        jobId: job.id,
        audioPath,
        musicId: audio_id,
        clipPaths,
        hookTexts,
        stylePackIds: style_pack_ids,
        presetIds,
        editCount: edit_count,
        platforms: resolvedPlatforms,
        seed: masterSeed,
        variationPool: variation_pool,
        durationMode: duration_mode,
        customDuration: custom_duration,
        clientSegments,
      };

      await generateBatch(opts);

      updateJob(job.id, {
        status: "done",
        step: "Gotowe",
        progress: 100,
      });
    } catch (err) {
      console.error("[mass-generate]", err);
      updateJob(job.id, {
        status: "error",
        error: (err as Error).message,
      });
    }
  });
});

// ── GET /api/style-packs ──────────────────────────────────

import { getAllStylePacks, saveStylePack, deleteStylePack } from "../utils/db.js";

massGenerateRouter.get("/style-packs", (_req, res) => {
  res.json(getAllStylePacks());
});

massGenerateRouter.post("/style-packs", (req, res) => {
  const { id, name, description, preset_ids } = req.body as {
    id?: string;
    name?: string;
    description?: string;
    preset_ids?: string[];
  };
  if (!name) return res.status(400).json({ error: "name is required" });
  const pack = {
    id: id ?? newId(),
    name,
    description,
    createdAt: Date.now(),
    presetIds: preset_ids ?? [],
  };
  saveStylePack(pack);
  res.status(201).json(pack);
});

massGenerateRouter.delete("/style-packs/:id", (req, res) => {
  deleteStylePack(req.params.id);
  res.json({ ok: true });
});

// ── GET /api/hook-packs ───────────────────────────────────

import { getAllHookPacks, saveHookPack, deleteHookPack } from "../utils/db.js";

massGenerateRouter.get("/hook-packs", (_req, res) => {
  res.json(getAllHookPacks());
});

massGenerateRouter.post("/hook-packs", (req, res) => {
  const { id, name, hook_ids } = req.body as {
    id?: string;
    name?: string;
    hook_ids?: string[];
  };
  if (!name) return res.status(400).json({ error: "name is required" });
  const pack = {
    id: id ?? newId(),
    name,
    createdAt: Date.now(),
    hookIds: hook_ids ?? [],
  };
  saveHookPack(pack);
  res.status(201).json(pack);
});

massGenerateRouter.delete("/hook-packs/:id", (req, res) => {
  deleteHookPack(req.params.id);
  res.json({ ok: true });
});

// ── GET /api/queue-status ─────────────────────────────────

massGenerateRouter.get("/queue-status", (_req, res) => {
  res.json({
    ...ffmpegQueue.status(),
    env_max_concurrency: process.env.MAX_FFMPEG_CONCURRENCY ?? "3 (default)",
  });
});
