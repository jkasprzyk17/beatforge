/**
 * SQLite-backed database.
 * All operations are synchronous (better-sqlite3).
 *
 * Tables: tracks, transcriptions, collections, collection_clips, hooks, presets
 * Migrates data from legacy db.json on first run if present.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// ── Bootstrap ─────────────────────────────────────────────

const DB_DIR = path.resolve("data");
const DB_PATH = path.join(DB_DIR, "beatforge.sqlite");

fs.mkdirSync(DB_DIR, { recursive: true });

const sql = new Database(DB_PATH);
sql.pragma("journal_mode = WAL");
sql.pragma("foreign_keys = ON");

sql.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id            TEXT PRIMARY KEY,
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    size          INTEGER NOT NULL,
    uploaded_at   TEXT NOT NULL,
    duration      REAL,
    bpm           REAL
  );

  CREATE TABLE IF NOT EXISTS transcriptions (
    music_id      TEXT PRIMARY KEY,
    segments_json TEXT NOT NULL,
    full_text     TEXT NOT NULL,
    duration      REAL NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collections (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    folder_id  TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collection_clips (
    collection_id TEXT NOT NULL,
    clip_path     TEXT NOT NULL,
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS hooks (
    id         TEXT PRIMARY KEY,
    text       TEXT NOT NULL,
    mood_id    TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS presets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    mood_id     TEXT,
    config_json TEXT NOT NULL
  );
`);

// ── Migrate from legacy db.json (runs once) ───────────────

const LEGACY_PATH = path.join(DB_DIR, "db.json");
const MIGRATED_FLAG = path.join(DB_DIR, ".migrated");

if (fs.existsSync(LEGACY_PATH) && !fs.existsSync(MIGRATED_FLAG)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_PATH, "utf8")) as {
      tracks?: LegacyTrack[];
      transcriptions?: LegacyTranscription[];
    };

    interface LegacyTrack {
      id: string;
      filename: string;
      originalName: string;
      size: number;
      uploadedAt: string;
      duration?: number;
      bpm?: number;
    }
    interface LegacyTranscription {
      musicId: string;
      segments: object[];
      fullText: string;
      duration: number;
      createdAt: string;
    }

    const insertTrack = sql.prepare(
      `INSERT OR IGNORE INTO tracks (id, filename, original_name, size, uploaded_at, duration, bpm)
       VALUES (@id, @filename, @originalName, @size, @uploadedAt, @duration, @bpm)`,
    );
    const insertTx = sql.prepare(
      `INSERT OR IGNORE INTO transcriptions (music_id, segments_json, full_text, duration, created_at)
       VALUES (@musicId, @segmentsJson, @fullText, @duration, @createdAt)`,
    );

    const migrate = sql.transaction(() => {
      for (const t of legacy.tracks ?? []) {
        insertTrack.run({
          ...t,
          originalName: t.originalName,
          uploadedAt: t.uploadedAt,
          duration: t.duration ?? null,
          bpm: t.bpm ?? null,
        });
      }
      for (const tr of legacy.transcriptions ?? []) {
        insertTx.run({
          musicId: tr.musicId,
          segmentsJson: JSON.stringify(tr.segments),
          fullText: tr.fullText,
          duration: tr.duration,
          createdAt: tr.createdAt,
        });
      }
    });
    migrate();
    fs.writeFileSync(MIGRATED_FLAG, new Date().toISOString(), "utf8");
    console.log("[db] Migrated legacy db.json → SQLite");
  } catch (e) {
    console.warn("[db] Legacy migration skipped:", (e as Error).message);
  }
}

// ── Types ─────────────────────────────────────────────────

export interface TrackRecord {
  id: string;
  filename: string;
  originalName: string;
  size: number;
  uploadedAt: string;
  duration?: number;
  bpm?: number;
}

export interface SegmentRecord {
  start: number;
  end: number;
  text: string;
  word?: boolean;
}

export interface TranscriptionRecord {
  musicId: string;
  segments: SegmentRecord[];
  fullText: string;
  duration: number;
  createdAt: string;
}

export interface CollectionRecord {
  id: string;
  name: string;
  folderId?: string;
  createdAt: number;
  clipPaths: string[];
}

export interface HookRecord {
  id: string;
  text: string;
  moodId?: string;
  createdAt: number;
}

export interface PresetRecord {
  id: string;
  name: string;
  moodId?: string;
  config: object;
}

// ── Tracks ────────────────────────────────────────────────

export function saveTrack(track: TrackRecord): void {
  sql
    .prepare(
      `INSERT OR REPLACE INTO tracks (id, filename, original_name, size, uploaded_at, duration, bpm)
     VALUES (@id, @filename, @originalName, @size, @uploadedAt, @duration, @bpm)`,
    )
    .run({
      id: track.id,
      filename: track.filename,
      originalName: track.originalName,
      size: track.size,
      uploadedAt: track.uploadedAt,
      duration: track.duration !== undefined ? track.duration : null,
      bpm: track.bpm !== undefined ? track.bpm : null,
    });
}

export function getAllTracks(): TrackRecord[] {
  return (
    sql.prepare("SELECT * FROM tracks ORDER BY uploaded_at DESC").all() as {
      id: string;
      filename: string;
      original_name: string;
      size: number;
      uploaded_at: string;
      duration: number | null;
      bpm: number | null;
    }[]
  ).map((r) => ({
    id: r.id,
    filename: r.filename,
    originalName: r.original_name,
    size: r.size,
    uploadedAt: r.uploaded_at,
    duration: r.duration !== null ? r.duration : undefined,
    bpm: r.bpm !== null ? r.bpm : undefined,
  }));
}

export function deleteTrack(id: string): void {
  sql.transaction(() => {
    sql.prepare("DELETE FROM transcriptions WHERE music_id = ?").run(id);
    sql.prepare("DELETE FROM tracks WHERE id = ?").run(id);
  })();
}

// ── Transcriptions ────────────────────────────────────────

export function saveTranscription(rec: TranscriptionRecord): void {
  sql
    .prepare(
      `INSERT OR REPLACE INTO transcriptions (music_id, segments_json, full_text, duration, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      rec.musicId,
      JSON.stringify(rec.segments),
      rec.fullText,
      rec.duration,
      rec.createdAt,
    );
}

export function getTranscription(musicId: string): TranscriptionRecord | null {
  const row = sql
    .prepare("SELECT * FROM transcriptions WHERE music_id = ?")
    .get(musicId) as
    | {
        music_id: string;
        segments_json: string;
        full_text: string;
        duration: number;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    musicId: row.music_id,
    segments: JSON.parse(row.segments_json) as SegmentRecord[],
    fullText: row.full_text,
    duration: row.duration,
    createdAt: row.created_at,
  };
}

// ── Collections ───────────────────────────────────────────

export function saveCollection(col: CollectionRecord): void {
  sql.transaction(() => {
    sql
      .prepare(
        `INSERT OR REPLACE INTO collections (id, name, folder_id, created_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run(col.id, col.name, col.folderId ?? null, col.createdAt);

    sql
      .prepare("DELETE FROM collection_clips WHERE collection_id = ?")
      .run(col.id);
    const ins = sql.prepare(
      "INSERT INTO collection_clips (collection_id, clip_path) VALUES (?, ?)",
    );
    for (const p of col.clipPaths) ins.run(col.id, p);
  })();
}

export function getAllCollections(): CollectionRecord[] {
  const rows = sql
    .prepare("SELECT * FROM collections ORDER BY created_at DESC")
    .all() as {
    id: string;
    name: string;
    folder_id: string | null;
    created_at: number;
  }[];
  const clipRows = sql.prepare("SELECT * FROM collection_clips").all() as {
    collection_id: string;
    clip_path: string;
  }[];
  const clipsMap = new Map<string, string[]>();
  for (const r of clipRows) {
    if (!clipsMap.has(r.collection_id)) clipsMap.set(r.collection_id, []);
    clipsMap.get(r.collection_id)!.push(r.clip_path);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    folderId: r.folder_id ?? undefined,
    createdAt: r.created_at,
    clipPaths: clipsMap.get(r.id) ?? [],
  }));
}

export function updateCollectionFolder(
  id: string,
  folderId: string | undefined,
): void {
  sql
    .prepare("UPDATE collections SET folder_id = ? WHERE id = ?")
    .run(folderId ?? null, id);
}

export function updateCollectionName(id: string, name: string): void {
  sql.prepare("UPDATE collections SET name = ? WHERE id = ?").run(name, id);
}

export function deleteCollection(id: string): void {
  sql.prepare("DELETE FROM collections WHERE id = ?").run(id);
}

// ── Hooks ──────────────────────────────────────────────────

export function saveHook(hook: HookRecord): void {
  sql
    .prepare(
      `INSERT OR REPLACE INTO hooks (id, text, mood_id, created_at)
     VALUES (?, ?, ?, ?)`,
    )
    .run(hook.id, hook.text, hook.moodId ?? null, hook.createdAt);
}

export function getAllHooks(): HookRecord[] {
  return (
    sql.prepare("SELECT * FROM hooks ORDER BY created_at DESC").all() as {
      id: string;
      text: string;
      mood_id: string | null;
      created_at: number;
    }[]
  ).map((r) => ({
    id: r.id,
    text: r.text,
    moodId: r.mood_id ?? undefined,
    createdAt: r.created_at,
  }));
}

export function deleteHook(id: string): void {
  sql.prepare("DELETE FROM hooks WHERE id = ?").run(id);
}

// ── Presets ────────────────────────────────────────────────

export function savePreset(preset: PresetRecord): void {
  sql
    .prepare(
      `INSERT OR REPLACE INTO presets (id, name, mood_id, config_json)
     VALUES (?, ?, ?, ?)`,
    )
    .run(
      preset.id,
      preset.name,
      preset.moodId ?? null,
      JSON.stringify(preset.config),
    );
}

export function getPreset(id: string): PresetRecord | null {
  const row = sql.prepare("SELECT * FROM presets WHERE id = ?").get(id) as
    | {
        id: string;
        name: string;
        mood_id: string | null;
        config_json: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    moodId: row.mood_id ?? undefined,
    config: JSON.parse(row.config_json) as object,
  };
}

export function getAllPresets(): PresetRecord[] {
  return (
    sql.prepare("SELECT * FROM presets").all() as {
      id: string;
      name: string;
      mood_id: string | null;
      config_json: string;
    }[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    moodId: r.mood_id ?? undefined,
    config: JSON.parse(r.config_json) as object,
  }));
}

export function deletePreset(id: string): void {
  sql.prepare("DELETE FROM presets WHERE id = ?").run(id);
}
