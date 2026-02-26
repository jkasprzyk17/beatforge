/**
 * SQLite-backed job store.
 *
 * Public API is identical to the old in-memory version so callers
 * (generate.ts) need zero changes.  Jobs now survive server restarts.
 *
 * Tables (defined in db.ts):
 *   jobs        — one row per generation job
 *   job_outputs — one row per rendered variant / platform
 */

import { db } from "./db.js";

// ── Types ─────────────────────────────────────────────────

export type JobStatus = "queued" | "processing" | "done" | "error";

export interface JobOutput {
  variant: number;
  platform: string;
  style: string;
  preset_id: string | null;
  final_duration: number;
  video_url: string;
  caption_url: string;
  thumb_url?: string;
  // Legacy field kept for backward compat
  srt_url?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  created_at: number;
  updated_at: number;
  outputs: JobOutput[];
  error?: string;
  /** Current processing step label, e.g. "Montaż wideo…" */
  step?: string;
  /** Overall progress 0–100 */
  progress?: number;
  /** Total number of variants that will be rendered */
  total_variants?: number;
  /** Number of variants already finished */
  done_variants?: number;
  /** Phases that were skipped (e.g. ["transcription"] when segments provided by client) */
  phases_skipped?: string[];
}

// ── Internal row types ────────────────────────────────────

interface JobRow {
  id: string;
  status: JobStatus;
  created_at: number;
  updated_at: number;
  step: string | null;
  progress: number | null;
  total_variants: number | null;
  done_variants: number | null;
  error: string | null;
  phases_skipped: string | null;
}

interface OutputRow {
  id: number;
  job_id: string;
  variant: number;
  platform: string;
  style: string | null;
  preset_id: string | null;
  final_duration: number | null;
  video_url: string | null;
  caption_url: string | null;
  thumb_url: string | null;
}

// ── Row → domain object converters ───────────────────────

function rowToOutput(r: OutputRow): JobOutput {
  return {
    variant: r.variant,
    platform: r.platform,
    style: r.style ?? "",
    preset_id: r.preset_id,
    final_duration: r.final_duration ?? 0,
    video_url: r.video_url ?? "",
    caption_url: r.caption_url ?? "",
    thumb_url: r.thumb_url ?? undefined,
  };
}

function outputsForJob(jobId: string): JobOutput[] {
  return (
    db
      .prepare(
        "SELECT * FROM job_outputs WHERE job_id = ? ORDER BY id ASC",
      )
      .all(jobId) as OutputRow[]
  ).map(rowToOutput);
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    outputs: outputsForJob(row.id),
    step: row.step ?? undefined,
    progress: row.progress ?? undefined,
    total_variants: row.total_variants ?? undefined,
    done_variants: row.done_variants ?? undefined,
    error: row.error ?? undefined,
    phases_skipped: row.phases_skipped
      ? (JSON.parse(row.phases_skipped) as string[])
      : undefined,
  };
}

// ── Prepared statements (cached for performance) ──────────

const stmtInsertJob = db.prepare(
  `INSERT INTO jobs (id, status, created_at, updated_at)
   VALUES (?, 'queued', ?, ?)`,
);

const stmtGetJob = db.prepare(
  "SELECT * FROM jobs WHERE id = ?",
);

const stmtListJobs = db.prepare(
  "SELECT * FROM jobs ORDER BY created_at DESC",
);

const stmtAllOutputs = db.prepare(
  "SELECT * FROM job_outputs ORDER BY id ASC",
);

const stmtDeleteJob = db.prepare(
  "DELETE FROM jobs WHERE id = ?",
);

const stmtInsertOutput = db.prepare(
  `INSERT INTO job_outputs
     (job_id, variant, platform, style, preset_id, final_duration, video_url, caption_url, thumb_url)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const stmtTouchJob = db.prepare(
  "UPDATE jobs SET updated_at = ? WHERE id = ?",
);

// ── Public API ────────────────────────────────────────────

export function createJob(id: string): Job {
  const now = Date.now();
  stmtInsertJob.run(id, now, now);
  return getJob(id)!;
}

export function getJob(id: string): Job | undefined {
  const row = stmtGetJob.get(id) as JobRow | undefined;
  if (!row) return undefined;
  return rowToJob(row);
}

export function listJobs(): Job[] {
  const rows = stmtListJobs.all() as JobRow[];
  if (!rows.length) return [];

  // Fetch all outputs in one query, then group by job_id — avoids N+1
  const allOutputs = stmtAllOutputs.all() as OutputRow[];
  const byJob = new Map<string, JobOutput[]>();
  for (const o of allOutputs) {
    const list = byJob.get(o.job_id) ?? [];
    list.push(rowToOutput(o));
    byJob.set(o.job_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    outputs: byJob.get(row.id) ?? [],
    step: row.step ?? undefined,
    progress: row.progress ?? undefined,
    total_variants: row.total_variants ?? undefined,
    done_variants: row.done_variants ?? undefined,
    error: row.error ?? undefined,
    phases_skipped: row.phases_skipped
      ? (JSON.parse(row.phases_skipped) as string[])
      : undefined,
  }));
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const now = Date.now();

  // Build a dynamic SET clause from only the defined scalar fields in patch.
  // outputs is handled separately via addOutput(); id/created_at never change.
  const setClauses: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];

  if (patch.status        !== undefined) { setClauses.push("status = ?");         values.push(patch.status); }
  if (patch.step          !== undefined) { setClauses.push("step = ?");            values.push(patch.step); }
  if (patch.progress      !== undefined) { setClauses.push("progress = ?");        values.push(patch.progress); }
  if (patch.total_variants !== undefined) { setClauses.push("total_variants = ?"); values.push(patch.total_variants); }
  if (patch.done_variants !== undefined) { setClauses.push("done_variants = ?");   values.push(patch.done_variants); }
  if (patch.error         !== undefined) { setClauses.push("error = ?");           values.push(patch.error); }
  if (patch.phases_skipped !== undefined) {
    setClauses.push("phases_skipped = ?");
    values.push(JSON.stringify(patch.phases_skipped));
  }

  values.push(id);
  db.prepare(`UPDATE jobs SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function addOutput(id: string, output: JobOutput): void {
  stmtInsertOutput.run(
    id,
    output.variant,
    output.platform,
    output.style,
    output.preset_id,
    output.final_duration,
    output.video_url,
    output.caption_url,
    output.thumb_url ?? null,
  );
  stmtTouchJob.run(Date.now(), id);
}

export function deleteJob(id: string): boolean {
  const result = stmtDeleteJob.run(id);
  return result.changes > 0;
}
