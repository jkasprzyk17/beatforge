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

// ── POST /api/hooks/import ─────────────────────────────────
// Body: { hooks: Array<{ text: string, mood_id?: string }> }
// Creates many hooks in one request (e.g. from CSV import).

hooksRouter.post("/hooks/import", (req, res) => {
  const { hooks: raw } = req.body as {
    hooks?: Array<{ text?: string; mood_id?: string }>;
  };

  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: "hooks array is required and must not be empty" });
  }

  const created: HookRecord[] = [];
  for (const item of raw) {
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const record: HookRecord = {
      id: newId(),
      text,
      moodId: item.mood_id && String(item.mood_id).trim() ? String(item.mood_id).trim() : undefined,
      createdAt: Date.now(),
    };
    saveHook(record);
    created.push(record);
  }

  res.json({ created, count: created.length });
});

// ── DELETE /api/hooks/:id ─────────────────────────────────

hooksRouter.delete("/hooks/:id", (req, res) => {
  deleteHook(req.params.id);
  res.json({ ok: true });
});
