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
import { getDataDir } from "./helpers.js";

// ── Bootstrap ─────────────────────────────────────────────
const DB_DIR = getDataDir();
const DB_PATH = path.join(DB_DIR, "beatforge.sqlite");

fs.mkdirSync(DB_DIR, { recursive: true });

const sql = new Database(DB_PATH);
sql.pragma("journal_mode = WAL");
sql.pragma("foreign_keys = ON");

sql.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id             TEXT PRIMARY KEY,
    status         TEXT NOT NULL DEFAULT 'queued',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    step           TEXT,
    progress       INTEGER,
    total_variants INTEGER,
    done_variants  INTEGER,
    error          TEXT,
    phases_skipped TEXT
  );

  CREATE TABLE IF NOT EXISTS job_outputs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id         TEXT NOT NULL,
    variant        INTEGER NOT NULL,
    platform       TEXT NOT NULL,
    style          TEXT,
    preset_id      TEXT,
    final_duration REAL,
    video_url      TEXT,
    caption_url    TEXT,
    thumb_url      TEXT,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

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
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    folder_id     TEXT,
    created_at    INTEGER NOT NULL,
    thumbnail_url TEXT
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

  CREATE TABLE IF NOT EXISTS clip_metadata (
    path      TEXT PRIMARY KEY,  -- absolute file path
    mtime     INTEGER NOT NULL,  -- file mtime in ms — used as cache-validity key
    duration  REAL    NOT NULL,
    width     INTEGER,
    height    INTEGER,
    fps       REAL,
    codec     TEXT,
    cached_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- ── Style packs ─────────────────────────────────────────
  -- A style pack is a named collection of preset IDs.
  -- Users select one or more style packs per batch.
  -- The mass generator assigns packs to edits via round-robin rotation.
  CREATE TABLE IF NOT EXISTS style_packs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    created_at  INTEGER NOT NULL
  );

  -- Junction: which presets belong to which style pack.
  -- sort_order controls which preset is the "primary" (index 0).
  CREATE TABLE IF NOT EXISTS style_pack_presets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    style_pack_id TEXT NOT NULL,
    preset_id     TEXT NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (style_pack_id) REFERENCES style_packs(id) ON DELETE CASCADE
  );

  -- ── Hook packs ──────────────────────────────────────────
  -- A hook pack is a named collection of hook IDs (text overlays).
  -- The mass generator picks hooks from the pack using seeded RNG.
  CREATE TABLE IF NOT EXISTS hook_packs (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hook_pack_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    hook_pack_id TEXT NOT NULL,
    hook_id      TEXT NOT NULL,
    FOREIGN KEY (hook_pack_id) REFERENCES hook_packs(id) ON DELETE CASCADE
  );

  -- ── Generation manifests ─────────────────────────────────
  -- One row per edit (not per edit × platform).
  -- Written BEFORE any FFmpeg process starts → crash-safe.
  -- On recovery: query WHERE status='pending' AND job_id=? to resume.
  CREATE TABLE IF NOT EXISTS generation_manifests (
    id             TEXT PRIMARY KEY,
    job_id         TEXT NOT NULL,
    edit_index     INTEGER NOT NULL,
    seed           INTEGER NOT NULL,       -- per-edit seed (derived from master)
    master_seed    INTEGER NOT NULL,       -- batch master seed (for audit)
    audio_path     TEXT NOT NULL,
    style_pack_id  TEXT NOT NULL,
    preset_id      TEXT NOT NULL,
    selected_clips TEXT NOT NULL,          -- JSON array of absolute clip paths
    hook_text      TEXT,                   -- resolved hook text (null = no overlay)
    variation_json TEXT NOT NULL,          -- JSON of ResolvedVariation
    status         TEXT NOT NULL DEFAULT 'pending',  -- pending | done | error
    error          TEXT,
    created_at     INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  -- ── Compositions (layer-based Studio projects) ─────────────────────────
  -- One composition per Studio session; layers stored as JSON.
  CREATE TABLE IF NOT EXISTS compositions (
    id           TEXT PRIMARY KEY,
    audio_id     TEXT NOT NULL,
    aspect_ratio TEXT NOT NULL,
    resize_mode  TEXT NOT NULL,
    seed         INTEGER,
    layers_json  TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
`);

// ── Column migrations (idempotent — ALTER TABLE ignores if already present) ──
for (const stmt of [
  "ALTER TABLE collections ADD COLUMN thumbnail_url TEXT",
  "ALTER TABLE compositions ADD COLUMN output_display_mode TEXT",
]) {
  try { sql.exec(stmt); } catch { /* column already exists */ }
}

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
  thumbnailUrl?: string;
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
        `INSERT OR REPLACE INTO collections (id, name, folder_id, created_at, thumbnail_url)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(col.id, col.name, col.folderId ?? null, col.createdAt, col.thumbnailUrl ?? null);

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
    thumbnail_url: string | null;
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
    thumbnailUrl: r.thumbnail_url ?? undefined,
  }));
}

export function updateCollectionThumbnail(
  id: string,
  thumbnailUrl: string,
): void {
  sql
    .prepare("UPDATE collections SET thumbnail_url = ? WHERE id = ?")
    .run(thumbnailUrl, id);
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

// ── Clip metadata cache ────────────────────────────────────
//
// Keyed by (path, mtime).  If the file's mtime changes the cached row is
// silently ignored and replaced on the next ffprobe run.

export interface ClipMetaRecord {
  path:      string;
  mtime:     number; // mtimeMs truncated to integer
  duration:  number;
  width?:    number;
  height?:   number;
  fps?:      number;
  codec?:    string;
}

/**
 * Return cached metadata for `filePath` iff the cached mtime equals the
 * provided `mtime` (caller is responsible for stating the file once).
 * Returns null on any miss or error.
 */
export function getCachedClipMeta(
  filePath: string,
  mtime: number,
): ClipMetaRecord | null {
  try {
    const row = sql
      .prepare("SELECT * FROM clip_metadata WHERE path = ? AND mtime = ?")
      .get(filePath, mtime) as
      | {
          path: string; mtime: number; duration: number;
          width: number | null; height: number | null;
          fps: number | null; codec: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      path:     row.path,
      mtime:    row.mtime,
      duration: row.duration,
      width:    row.width    ?? undefined,
      height:   row.height   ?? undefined,
      fps:      row.fps      ?? undefined,
      codec:    row.codec    ?? undefined,
    };
  } catch {
    return null;
  }
}

/** Upsert a clip metadata entry (overwrites any stale row for the same path). */
export function saveClipMeta(meta: ClipMetaRecord): void {
  sql
    .prepare(
      `INSERT OR REPLACE INTO clip_metadata
         (path, mtime, duration, width, height, fps, codec, cached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meta.path,
      meta.mtime,
      meta.duration,
      meta.width   ?? null,
      meta.height  ?? null,
      meta.fps     ?? null,
      meta.codec   ?? null,
      Date.now(),
    );
}

/**
 * Remove cache entries whose files no longer exist on disk.
 * Cheap maintenance call — safe to run periodically.
 */
export function pruneClipMetaCache(): number {
  const rows = sql
    .prepare("SELECT path FROM clip_metadata")
    .all() as { path: string }[];

  const toDelete = rows.filter((r) => !fs.existsSync(r.path));
  if (!toDelete.length) return 0;

  const del = sql.prepare("DELETE FROM clip_metadata WHERE path = ?");
  const tx  = sql.transaction(() => toDelete.forEach((r) => del.run(r.path)));
  tx();
  return toDelete.length;
}

// ── Export history ────────────────────────────────────────
//
// A flat, export-centric view: one entry per rendered output file.
// Only outputs from completed ('done') jobs are returned.

export interface ExportHistoryEntry {
  job_id:         string;
  created_at:     number; // job creation timestamp (ms)
  variant:        number;
  platform:       string;
  style:          string | null;
  preset_id:      string | null;
  final_duration: number | null;
  video_url:      string | null;
  caption_url:    string | null;
  thumb_url:      string | null;
}

export function getExportHistory(): ExportHistoryEntry[] {
  return sql.prepare(`
    SELECT
      jo.job_id,
      j.created_at,
      jo.variant,
      jo.platform,
      jo.style,
      jo.preset_id,
      jo.final_duration,
      jo.video_url,
      jo.caption_url,
      jo.thumb_url
    FROM job_outputs jo
    JOIN jobs j ON jo.job_id = j.id
    WHERE j.status = 'done'
    ORDER BY j.created_at DESC
  `).all() as ExportHistoryEntry[];
}

// ── Startup: mark interrupted jobs as error ───────────────
// Any job left in queued/processing from a previous run will
// never finish — surface it as an error instead of hanging forever.
sql
  .prepare(
    `UPDATE jobs
     SET status = 'error',
         error  = 'Server restarted — job was interrupted',
         updated_at = ?
     WHERE status IN ('queued', 'processing')`,
  )
  .run(Date.now());

// ── Style packs ───────────────────────────────────────────

export interface StylePackRecord {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  presetIds: string[]; // ordered by sort_order asc
}

export function saveStylePack(pack: StylePackRecord): void {
  sql.transaction(() => {
    sql
      .prepare(
        `INSERT OR REPLACE INTO style_packs (id, name, description, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(pack.id, pack.name, pack.description ?? null, pack.createdAt);

    sql
      .prepare("DELETE FROM style_pack_presets WHERE style_pack_id = ?")
      .run(pack.id);

    const ins = sql.prepare(
      "INSERT INTO style_pack_presets (style_pack_id, preset_id, sort_order) VALUES (?, ?, ?)",
    );
    pack.presetIds.forEach((pid, idx) => ins.run(pack.id, pid, idx));
  })();
}

export function getAllStylePacks(): StylePackRecord[] {
  const rows = sql
    .prepare("SELECT * FROM style_packs ORDER BY created_at DESC")
    .all() as { id: string; name: string; description: string | null; created_at: number }[];

  const presetRows = sql
    .prepare(
      "SELECT style_pack_id, preset_id FROM style_pack_presets ORDER BY sort_order ASC",
    )
    .all() as { style_pack_id: string; preset_id: string }[];

  const presetMap = new Map<string, string[]>();
  for (const r of presetRows) {
    const list = presetMap.get(r.style_pack_id) ?? [];
    list.push(r.preset_id);
    presetMap.set(r.style_pack_id, list);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    createdAt: r.created_at,
    presetIds: presetMap.get(r.id) ?? [],
  }));
}

export function getStylePackPresetIds(packId: string): string[] {
  return (
    sql
      .prepare(
        "SELECT preset_id FROM style_pack_presets WHERE style_pack_id = ? ORDER BY sort_order ASC",
      )
      .all(packId) as { preset_id: string }[]
  ).map((r) => r.preset_id);
}

export function deleteStylePack(id: string): void {
  sql.prepare("DELETE FROM style_packs WHERE id = ?").run(id);
}

// ── Hook packs ────────────────────────────────────────────

export interface HookPackRecord {
  id: string;
  name: string;
  createdAt: number;
  hookIds: string[];
}

export function saveHookPack(pack: HookPackRecord): void {
  sql.transaction(() => {
    sql
      .prepare(
        `INSERT OR REPLACE INTO hook_packs (id, name, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(pack.id, pack.name, pack.createdAt);

    sql
      .prepare("DELETE FROM hook_pack_items WHERE hook_pack_id = ?")
      .run(pack.id);

    const ins = sql.prepare(
      "INSERT INTO hook_pack_items (hook_pack_id, hook_id) VALUES (?, ?)",
    );
    for (const hid of pack.hookIds) ins.run(pack.id, hid);
  })();
}

export function getAllHookPacks(): HookPackRecord[] {
  const rows = sql
    .prepare("SELECT * FROM hook_packs ORDER BY created_at DESC")
    .all() as { id: string; name: string; created_at: number }[];

  const itemRows = sql
    .prepare("SELECT hook_pack_id, hook_id FROM hook_pack_items")
    .all() as { hook_pack_id: string; hook_id: string }[];

  const itemMap = new Map<string, string[]>();
  for (const r of itemRows) {
    const list = itemMap.get(r.hook_pack_id) ?? [];
    list.push(r.hook_id);
    itemMap.set(r.hook_pack_id, list);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    hookIds: itemMap.get(r.id) ?? [],
  }));
}

/**
 * Resolve the text strings for all hooks in a pack.
 * Returns empty array if pack not found or pack has no hooks.
 */
export function getHookPackTexts(packId: string): string[] {
  const rows = sql
    .prepare(
      `SELECT h.text FROM hook_pack_items hpi
       JOIN hooks h ON h.id = hpi.hook_id
       WHERE hpi.hook_pack_id = ?`,
    )
    .all(packId) as { text: string }[];
  return rows.map((r) => r.text);
}

export function deleteHookPack(id: string): void {
  sql.prepare("DELETE FROM hook_packs WHERE id = ?").run(id);
}

// ── Compositions ─────────────────────────────────────────────

export interface CompositionRecord {
  id: string;
  audioId: string;
  aspectRatio: string;
  resizeMode: string;
  outputDisplayMode?: string; // "full" | "1:1_letterbox"
  seed: number | null;
  layers: object[];
  createdAt: number;
  updatedAt: number;
}

export function saveComposition(rec: CompositionRecord): void {
  sql
    .prepare(
      `INSERT OR REPLACE INTO compositions
       (id, audio_id, aspect_ratio, resize_mode, output_display_mode, seed, layers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.id,
      rec.audioId,
      rec.aspectRatio,
      rec.resizeMode,
      rec.outputDisplayMode ?? "full",
      rec.seed ?? null,
      JSON.stringify(rec.layers),
      rec.createdAt,
      rec.updatedAt,
    );
}

export function getComposition(id: string): CompositionRecord | null {
  const row = sql.prepare("SELECT * FROM compositions WHERE id = ?").get(id) as
    | {
        id: string;
        audio_id: string;
        aspect_ratio: string;
        resize_mode: string;
        output_display_mode?: string | null;
        seed: number | null;
        layers_json: string;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    audioId: row.audio_id,
    aspectRatio: row.aspect_ratio,
    resizeMode: row.resize_mode,
    outputDisplayMode: row.output_display_mode ?? "full",
    seed: row.seed,
    layers: JSON.parse(row.layers_json) as object[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getCompositionsByAudio(audioId: string): CompositionRecord[] {
  const rows = sql
    .prepare("SELECT * FROM compositions WHERE audio_id = ? ORDER BY updated_at DESC")
    .all(audioId) as {
    id: string;
    audio_id: string;
    aspect_ratio: string;
    resize_mode: string;
    output_display_mode?: string | null;
    seed: number | null;
    layers_json: string;
    created_at: number;
    updated_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    audioId: r.audio_id,
    aspectRatio: r.aspect_ratio,
    resizeMode: r.resize_mode,
    outputDisplayMode: r.output_display_mode ?? "full",
    seed: r.seed,
    layers: JSON.parse(r.layers_json) as object[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function deleteComposition(id: string): void {
  sql.prepare("DELETE FROM compositions WHERE id = ?").run(id);
}

// ── Generation manifests ───────────────────────────────────

export interface ManifestRecord {
  id: string;
  jobId: string;
  editIndex: number;
  seed: number;
  masterSeed: number;
  audioPath: string;
  stylePackId: string;
  presetId: string;
  selectedClips: string[];
  hookText: string | null;
  variationJson: string;
  status: "pending" | "done" | "error";
  error?: string;
  createdAt: number;
}

const stmtInsertManifest = sql.prepare(`
  INSERT OR REPLACE INTO generation_manifests
    (id, job_id, edit_index, seed, master_seed, audio_path,
     style_pack_id, preset_id, selected_clips, hook_text,
     variation_json, status, error, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function saveManifest(m: ManifestRecord): void {
  stmtInsertManifest.run(
    m.id,
    m.jobId,
    m.editIndex,
    m.seed,
    m.masterSeed,
    m.audioPath,
    m.stylePackId,
    m.presetId,
    JSON.stringify(m.selectedClips),
    m.hookText,
    m.variationJson,
    m.status,
    m.error ?? null,
    m.createdAt,
  );
}

export function markManifestDone(id: string): void {
  sql
    .prepare(
      "UPDATE generation_manifests SET status = 'done', error = NULL WHERE id = ?",
    )
    .run(id);
}

export function markManifestFailed(id: string, error: string): void {
  sql
    .prepare(
      "UPDATE generation_manifests SET status = 'error', error = ? WHERE id = ?",
    )
    .run(error, id);
}

export function getPendingManifests(jobId: string): ManifestRecord[] {
  return (
    sql
      .prepare(
        `SELECT * FROM generation_manifests
         WHERE job_id = ? AND status = 'pending'
         ORDER BY edit_index ASC`,
      )
      .all(jobId) as ManifestRow[]
  ).map((r) => ({
    id: r.id,
    jobId: r.job_id,
    editIndex: r.edit_index,
    seed: r.seed,
    masterSeed: r.master_seed,
    audioPath: r.audio_path,
    stylePackId: r.style_pack_id,
    presetId: r.preset_id,
    selectedClips: JSON.parse(r.selected_clips) as string[],
    hookText: r.hook_text,
    variationJson: r.variation_json,
    status: r.status,
    error: r.error ?? undefined,
    createdAt: r.created_at,
  }));
}

interface ManifestRow {
  id: string;
  job_id: string;
  edit_index: number;
  seed: number;
  master_seed: number;
  audio_path: string;
  style_pack_id: string;
  preset_id: string;
  selected_clips: string;
  hook_text: string | null;
  variation_json: string;
  status: "pending" | "done" | "error";
  error: string | null;
  created_at: number;
}

export function getManifestsByJob(jobId: string): ManifestRecord[] {
  return (
    sql
      .prepare(
        `SELECT * FROM generation_manifests WHERE job_id = ? ORDER BY edit_index ASC`,
      )
      .all(jobId) as ManifestRow[]
  ).map((r) => ({
    id: r.id,
    jobId: r.job_id,
    editIndex: r.edit_index,
    seed: r.seed,
    masterSeed: r.master_seed,
    audioPath: r.audio_path,
    stylePackId: r.style_pack_id,
    presetId: r.preset_id,
    selectedClips: JSON.parse(r.selected_clips) as string[],
    hookText: r.hook_text,
    variationJson: r.variation_json,
    status: r.status,
    error: r.error ?? undefined,
    createdAt: r.created_at,
  }));
}

// ── Expose raw db handle for jobs.ts ─────────────────────
export { sql as db };
