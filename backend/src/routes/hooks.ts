import { Router } from "express";
import {
  saveHook,
  getAllHooks,
  deleteHook,
  type HookRecord,
} from "../utils/db.js";
import { newId } from "../utils/helpers.js";

export const hooksRouter = Router();

// ── GET /api/hooks ────────────────────────────────────────

hooksRouter.get("/hooks", (_req, res) => {
  res.json(getAllHooks());
});

// ── POST /api/hooks ───────────────────────────────────────
// Body: { id?, text, mood_id? }

hooksRouter.post("/hooks", (req, res) => {
  const { id, text, mood_id } = req.body as {
    id?: string;
    text?: string;
    mood_id?: string;
  };

  if (!text?.trim()) {
    return res.status(400).json({ error: "text is required" });
  }

  const record: HookRecord = {
    id: id || newId(),
    text: text.trim(),
    moodId: mood_id || undefined,
    createdAt: Date.now(),
  };

  saveHook(record);
  res.json(record);
});

// ── DELETE /api/hooks/:id ─────────────────────────────────

hooksRouter.delete("/hooks/:id", (req, res) => {
  deleteHook(req.params.id);
  res.json({ ok: true });
});
