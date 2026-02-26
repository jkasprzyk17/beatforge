/**
 * In-memory job store.
 * Swap for Redis + Bull in production for persistence across restarts.
 */

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

const store = new Map<string, Job>();

export function createJob(id: string): Job {
  const job: Job = {
    id,
    status: "queued",
    created_at: Date.now(),
    updated_at: Date.now(),
    outputs: [],
  };
  store.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return store.get(id);
}

export function listJobs(): Job[] {
  return [...store.values()].sort((a, b) => b.created_at - a.created_at);
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const job = store.get(id);
  if (!job) return;
  Object.assign(job, patch, { updated_at: Date.now() });
}

export function addOutput(id: string, output: JobOutput): void {
  const job = store.get(id);
  if (!job) return;
  job.outputs.push(output);
  job.updated_at = Date.now();
}

export function deleteJob(id: string): boolean {
  return store.delete(id);
}
