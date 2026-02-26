import { Router } from "express";
import fs from "node:fs";
import {
  saveCollection,
  getAllCollections,
  deleteCollection,
  updateCollectionName,
  updateCollectionFolder,
  type CollectionRecord,
} from "../utils/db.js";
import { clipFiles, clipsDir } from "../utils/helpers.js";

export const collectionsRouter = Router();

// ── GET /api/collections ──────────────────────────────────

collectionsRouter.get("/collections", (_req, res) => {
  const collections = getAllCollections();
  res.json(collections);
});

// ── POST /api/collections ─────────────────────────────────
// Body: { id, name, folder_id?, clip_paths? }
// If clip_paths not provided, scans the clips directory on disk.

collectionsRouter.post("/collections", (req, res) => {
  const { id, name, folder_id, clip_paths } = req.body as {
    id?: string;
    name?: string;
    folder_id?: string;
    clip_paths?: string[];
  };

  if (!id || !name) {
    return res.status(400).json({ error: "id and name are required" });
  }

  // Resolve clip paths — either from payload or by scanning the clips directory
  let resolvedPaths: string[] = clip_paths ?? [];
  if (!resolvedPaths.length) {
    try {
      resolvedPaths = clipFiles(id);
    } catch {
      // clips_id directory may not exist yet — store empty list
      resolvedPaths = [];
    }
  }

  const record: CollectionRecord = {
    id,
    name,
    folderId: folder_id || undefined,
    createdAt: Date.now(),
    clipPaths: resolvedPaths,
  };

  saveCollection(record);
  res.json(record);
});

// ── PATCH /api/collections/:id ────────────────────────────
// Body: { name?, folder_id? }

collectionsRouter.patch("/collections/:id", (req, res) => {
  const { id } = req.params;
  const { name, folder_id } = req.body as { name?: string; folder_id?: string };

  if (name !== undefined) updateCollectionName(id, name);
  if (folder_id !== undefined)
    updateCollectionFolder(id, folder_id || undefined);

  res.json({ ok: true });
});

// ── DELETE /api/collections/:id ───────────────────────────

collectionsRouter.delete("/collections/:id", (req, res) => {
  deleteCollection(req.params.id);
  res.json({ ok: true });
});
