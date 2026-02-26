import { Router } from "express";
import {
  savePreset,
  getAllPresets,
  deletePreset,
  type PresetRecord,
} from "../utils/db.js";
import { loadPreset, seedDefaultPresets } from "../services/presetService.js";
import { newId } from "../utils/helpers.js";

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

// ── DELETE /api/presets/:id ───────────────────────────────

presetsRouter.delete("/presets/:id", (req, res) => {
  deletePreset(req.params.id);
  res.json({ ok: true });
});
