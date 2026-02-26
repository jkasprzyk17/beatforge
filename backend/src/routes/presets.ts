import path from "node:path";
import fs   from "node:fs";
import { Router } from "express";
import {
  savePreset,
  getAllPresets,
  deletePreset,
  type PresetRecord,
} from "../utils/db.js";
import { loadPreset, seedDefaultPresets } from "../services/presetService.js";
import { burnPresetThumb } from "../services/filtergraph.js";
import { newId, presetThumbPath, DIRS } from "../utils/helpers.js";

export const presetsRouter = Router();

// ── GET /api/presets ──────────────────────────────────────

presetsRouter.get("/presets", (_req, res) => {
  seedDefaultPresets(); // idempotent
  res.json(getAllPresets());
});

// ── GET /api/presets/:id ──────────────────────────────────

presetsRouter.get("/presets/:id", (req, res) => {
  const preset = loadPreset(req.params.id);
  if (!preset) return res.status(404).json({ error: "Preset not found" });
  res.json(preset);
});

// ── POST /api/presets ─────────────────────────────────────
// Body: { id?, name, mood_id?, config }

presetsRouter.post("/presets", (req, res) => {
  const { id, name, mood_id, config } = req.body as {
    id?: string;
    name?: string;
    mood_id?: string;
    config?: object;
  };

  if (!name?.trim() || !config || typeof config !== "object") {
    return res.status(400).json({ error: "name and config are required" });
  }

  const record: PresetRecord = {
    id: id || newId(),
    name: name.trim(),
    moodId: mood_id || undefined,
    config,
  };

  savePreset(record);
  res.json(record);
});

// ── GET /api/presets/:id/preview ─────────────────────────
// Returns a 160×90 JPEG thumbnail showing the preset's color grade and name.
// Generated lazily on first request; subsequent requests are served from disk.

presetsRouter.get("/presets/:id/preview", async (req, res) => {
  seedDefaultPresets();
  const preset = loadPreset(req.params.id);
  if (!preset) return res.status(404).json({ error: "Preset not found" });

  const thumbPath = presetThumbPath(preset.id);

  if (!fs.existsSync(thumbPath)) {
    try {
      fs.mkdirSync(DIRS.thumbs, { recursive: true });
      await burnPresetThumb(
        preset.name,
        preset.config.colorGrade,
        preset.config.captionColor,
        thumbPath,
        preset.config.captionFont,
      );
    } catch (err) {
      console.error("[preset-thumb]", err);
      return res.status(500).json({ error: "Failed to generate thumbnail" });
    }
  }

  res.sendFile(path.resolve(thumbPath));
});

// ── DELETE /api/presets/:id ───────────────────────────────

presetsRouter.delete("/presets/:id", (req, res) => {
  deletePreset(req.params.id);
  res.json({ ok: true });
});
