/**
 * Compositions API — CRUD for layer-based Studio compositions.
 */

import { Router } from "express";
import {
  saveComposition,
  getComposition,
  getCompositionsByAudio,
  deleteComposition,
  type CompositionRecord,
} from "../utils/db.js";

export const compositionsRouter = Router();

// ── GET /api/compositions/audio/:audioId ───────────────────

compositionsRouter.get("/compositions/audio/:audioId", (req, res) => {
  const list = getCompositionsByAudio(req.params.audioId);
  res.json(list);
});

// ── GET /api/compositions/:id ──────────────────────────────

compositionsRouter.get("/compositions/:id", (req, res) => {
  const comp = getComposition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Composition not found" });
  res.json(comp);
});

// ── POST /api/compositions ──────────────────────────────────
// Create or update. Body: { id, audioId, aspectRatio, resizeMode, outputDisplayMode?, seed?, layers }

compositionsRouter.post("/compositions", (req, res) => {
  const { id, audioId, aspectRatio, resizeMode, outputDisplayMode, seed, layers } = req.body as {
    id: string;
    audioId: string;
    aspectRatio: string;
    resizeMode: string;
    outputDisplayMode?: string;
    seed?: number;
    layers: object[];
  };
  if (!id || !audioId || !aspectRatio || !resizeMode || !Array.isArray(layers)) {
    return res.status(400).json({
      error: "id, audioId, aspectRatio, resizeMode, layers (array) required",
    });
  }
  const now = Date.now();
  const rec: CompositionRecord = {
    id,
    audioId,
    aspectRatio,
    resizeMode,
    outputDisplayMode: outputDisplayMode === "1:1_letterbox" ? "1:1_letterbox" : "full",
    seed: seed ?? null,
    layers,
    createdAt: now,
    updatedAt: now,
  };
  const existing = getComposition(id);
  if (existing) {
    rec.createdAt = existing.createdAt;
  }
  saveComposition(rec);
  res.json(rec);
});

// ── DELETE /api/compositions/:id ────────────────────────────

compositionsRouter.delete("/compositions/:id", (req, res) => {
  const comp = getComposition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Composition not found" });
  deleteComposition(req.params.id);
  res.json({ ok: true });
});
