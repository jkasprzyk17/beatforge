/**
 * BeatForge AI — typed API client
 *
 * Environment strategy
 * --------------------
 *  LOCAL DEV  — VITE_API_URL is empty ("") in .env.local.
 *               Vite's dev-server proxy forwards /api/* and /exports/*
 *               to http://localhost:8000, so no CORS headers are needed.
 *
 *  PRODUCTION — VITE_API_URL is set to the AWS backend origin in Vercel's
 *               environment variables, e.g. https://api.beatforge.com
 */

const BASE_URL: string = import.meta.env.VITE_API_URL ?? "";

// ---------------------------------------------------------------------------
// Generic fetch wrapper
// ---------------------------------------------------------------------------

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface UploadMusicResponse {
  music_id: string;
  filename: string;
  size: number;
}

export interface UploadClipsResponse {
  clips_id: string;
  clip_count: number;
  clips: { filename: string; size: number }[];
}

export interface PreviewResponse {
  preview_url: string;
  bpm: number;
  beats: number[]; // beat timestamps in seconds
}

export interface BatchResponse {
  job_id: string;
  status: string;
}

export interface JobOutput {
  variant: number;
  platform: string;
  style: string;
  preset_id?: string | null;
  final_duration?: number;
  video_url: string;
  caption_url: string;
  srt_url?: string;
  thumb_url?: string;
}

export interface JobMetadata {
  id: string;
  status: "queued" | "processing" | "done" | "error";
  created_at: number;
  updated_at: number;
  outputs: JobOutput[];
  error?: string;
  step?: string;
  progress?: number;
  total_variants?: number;
  done_variants?: number;
  phases_skipped?: string[];
}

// ---------------------------------------------------------------------------
// Upload endpoints
// ---------------------------------------------------------------------------

export async function uploadMusic(file: File): Promise<UploadMusicResponse> {
  const form = new FormData();
  form.append("file", file);
  return apiFetch<UploadMusicResponse>("/api/upload-music", {
    method: "POST",
    body: form,
  });
}

export async function uploadClips(files: File[]): Promise<UploadClipsResponse> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  return apiFetch<UploadClipsResponse>("/api/upload-clips", {
    method: "POST",
    body: form,
  });
}

// ---------------------------------------------------------------------------
// Generation endpoints
// ---------------------------------------------------------------------------

export interface PreviewRequest {
  music_id: string;
  clips_id: string;
  preview_duration?: number;
}

export async function generatePreview(
  payload: PreviewRequest,
): Promise<PreviewResponse> {
  return apiFetch<PreviewResponse>("/api/generate-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export interface BatchRequest {
  music_id: string;
  clips_id: string;
  platforms?: string[];
  preset_id?: string;
  caption_color?: string;
  caption_active_color?: string;
  caption_font?: string;       // "impact" | "oswald" | "montserrat" | "arial"
  caption_animation?: string;  // "pop" | "bounce" | "fade" | "none"
  caption_display_mode?: "1_word" | "2_words" | "3_words" | "1_line" | "2_lines" | "3_lines";
  caption_position?: "center" | "bottom"; // środek | na dole
  mood_id?: string;
  duration_mode?: "auto" | "custom";
  custom_duration?: number;
  batch_count?: number;
  segments?: { start: number; end: number; text: string }[];
  seed?: number; // 32-bit integer — makes renders reproducible
  hook_id?: string; // id hooka z puli (Text Hooks) — overlay POV/CTA w górnej 1/4 ekranu
  composition?: Composition; // layer-based format + overlays
}

export async function generateBatch(
  payload: BatchRequest,
): Promise<BatchResponse> {
  return apiFetch<BatchResponse>("/api/generate-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Job status
// ---------------------------------------------------------------------------

export async function getJob(jobId: string): Promise<JobMetadata> {
  return apiFetch<JobMetadata>(`/api/jobs/${jobId}`);
}

export async function getAllJobs(): Promise<JobMetadata[]> {
  return apiFetch<JobMetadata[]>("/api/jobs");
}

export interface ExportEntry {
  job_id:         string;
  created_at:     number;
  variant:        number;
  platform:       string;
  style:          string | null;
  preset_id:      string | null;
  final_duration: number | null;
  video_url:      string | null;
  caption_url:    string | null;
  thumb_url:      string | null;
}

/** Flat list of all completed export outputs, newest first. */
export async function getExports(): Promise<ExportEntry[]> {
  return apiFetch<ExportEntry[]>("/api/exports");
}

export interface QueueStatus {
  active:        number;
  pending:       number;
  maxConcurrent: number;
}

/** Current FFmpeg concurrency-queue status (active renders + waiting jobs). */
export async function getQueueStatus(): Promise<QueueStatus> {
  return apiFetch<QueueStatus>("/api/queue");
}

export async function deleteJob(jobId: string): Promise<void> {
  await apiFetch(`/api/jobs/${jobId}`, { method: "DELETE" });
}

/**
 * Subscribe to real-time job updates via SSE.
 *
 * Calls onUpdate on every push from the server.
 * Calls onDone once when status reaches "done" or "error", then closes.
 * Returns a cleanup function — call it to manually disconnect (e.g. on unmount).
 *
 * Falls back to a single REST poll if EventSource is unavailable (SSR / very old env).
 */
export function watchJob(
  jobId: string,
  onUpdate: (job: JobMetadata) => void,
  onDone: (job: JobMetadata) => void,
): () => void {
  if (typeof EventSource === "undefined") {
    // Fallback: single fetch, no live updates
    getJob(jobId).then((job) => { onUpdate(job); onDone(job); }).catch(() => {});
    return () => {};
  }

  const es = new EventSource(`${BASE_URL}/api/jobs/${jobId}/stream`);

  es.onmessage = (e: MessageEvent) => {
    try {
      const job = JSON.parse(e.data as string) as JobMetadata;
      onUpdate(job);
      if (job.status === "done" || job.status === "error") {
        onDone(job);
        es.close();
      }
    } catch {
      // malformed frame — ignore
    }
  };

  es.onerror = () => {
    // Connection dropped — close cleanly; component will show last known state
    es.close();
  };

  return () => es.close();
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export interface TrackRecord {
  id: string;
  filename: string;
  originalName: string;
  size: number;
  uploadedAt: string;
  duration?: number;
  bpm?: number;
}

export async function fetchTracks(): Promise<TrackRecord[]> {
  return apiFetch<TrackRecord[]>("/api/tracks");
}

export async function deleteTrack(id: string): Promise<void> {
  await apiFetch(`/api/tracks/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Collections (persisted)
// ---------------------------------------------------------------------------

export interface CollectionRecord {
  id: string;
  name: string;
  folderId?: string;
  createdAt: number;
  clipPaths: string[];
  thumbnailUrl?: string;
}

export async function fetchCollections(): Promise<CollectionRecord[]> {
  return apiFetch<CollectionRecord[]>("/api/collections");
}

export async function createCollection(payload: {
  id: string;
  name: string;
  folder_id?: string;
  clip_paths?: string[];
}): Promise<CollectionRecord> {
  return apiFetch<CollectionRecord>("/api/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function patchCollection(
  id: string,
  patch: {
    name?: string;
    folder_id?: string;
  },
): Promise<void> {
  await apiFetch(`/api/collections/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function removeCollection(id: string): Promise<void> {
  await apiFetch(`/api/collections/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Hooks (persisted)
// ---------------------------------------------------------------------------

export interface HookRecord {
  id: string;
  text: string;
  moodId?: string;
  createdAt: number;
}

export async function fetchHooks(): Promise<HookRecord[]> {
  return apiFetch<HookRecord[]>("/api/hooks");
}

export async function createHook(payload: {
  id?: string;
  text: string;
  mood_id?: string;
}): Promise<HookRecord> {
  return apiFetch<HookRecord>("/api/hooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function removeHook(id: string): Promise<void> {
  await apiFetch(`/api/hooks/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface PresetConfig {
  captionStyle: "bold_center" | "karaoke" | "minimal_clean";
  captionColor: string;
  captionActiveColor?: string;
  clipCutStrategy: "beat" | "random";
  transition: string;
  zoomPunch: boolean;
  speedVariation: boolean;
  colorGrade: string | null;
  energyBasedCuts: boolean;
  maxDuration?: number;
  description?: string;
  letterbox?: boolean;
  slowMotion?: boolean;
  captionAnimation?: string;
}

export interface PresetApiRecord {
  id: string;
  name: string;
  moodId?: string;
  config: PresetConfig;
}

export async function fetchPresets(): Promise<PresetApiRecord[]> {
  return apiFetch<PresetApiRecord[]>("/api/presets");
}

export async function fetchPreset(id: string): Promise<PresetApiRecord> {
  return apiFetch<PresetApiRecord>(`/api/presets/${id}`);
}

export async function createPreset(payload: {
  id?: string;
  name: string;
  mood_id?: string;
  config: PresetConfig;
}): Promise<PresetApiRecord> {
  return apiFetch<PresetApiRecord>("/api/presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Compositions (layer-based Studio)
// ---------------------------------------------------------------------------

export type AspectRatio = "9:16" | "1:1" | "4:5" | "16:9";
export type ResizeMode = "cover" | "contain" | "letterbox";
/** Vertical output: full 9:16 or 1:1 content centered in 9:16 with black bars. */
export type OutputDisplayMode = "full" | "1:1_letterbox";
export type LayerType =
  | "video_base"
  | "hook"
  | "lyrics"
  | "custom_text"
  | "cinematic_bars"
  | "color_grade";

export interface CustomTextConfig {
  text: string;
  font: string;
  fontSize: number;
  color: string;
  bgBox?: boolean;
  position: "top" | "center" | "bottom" | "custom";
  x?: number;
  y?: number;
  animation: "pop" | "slide" | "fade";
}

export interface CompositionLayer {
  id: string;
  type: LayerType;
  start: number;
  end: number;
  zIndex: number;
  config: Record<string, unknown>;
}

export interface Composition {
  id: string;
  audioId: string;
  aspectRatio: AspectRatio;
  resizeMode: ResizeMode;
  outputDisplayMode?: OutputDisplayMode;
  seed?: number;
  layers: CompositionLayer[];
}

export interface CompositionRecord {
  id: string;
  audioId: string;
  aspectRatio: string;
  resizeMode: string;
  outputDisplayMode?: string;
  seed: number | null;
  layers: object[];
  createdAt: number;
  updatedAt: number;
}

export async function fetchCompositionsByAudio(
  audioId: string,
): Promise<CompositionRecord[]> {
  return apiFetch<CompositionRecord[]>(`/api/compositions/audio/${audioId}`);
}

export async function fetchComposition(
  id: string,
): Promise<CompositionRecord> {
  return apiFetch<CompositionRecord>(`/api/compositions/${id}`);
}

export async function saveComposition(payload: {
  id: string;
  audioId: string;
  aspectRatio: string;
  resizeMode: string;
  outputDisplayMode?: string;
  seed?: number;
  layers: object[];
}): Promise<CompositionRecord> {
  return apiFetch<CompositionRecord>("/api/compositions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function removeComposition(id: string): Promise<void> {
  await apiFetch(`/api/compositions/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  word?: boolean;
}

export interface TranscriptionResponse {
  music_id: string;
  segments: TranscriptionSegment[];
  full_text: string;
  duration: number;
  cached?: boolean;
}

export async function transcribeTrack(
  musicId: string,
  force = false,
): Promise<TranscriptionResponse> {
  return apiFetch<TranscriptionResponse>("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ music_id: musicId, force }),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function absoluteUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

export function trackAudioUrl(musicId: string): string {
  return `${BASE_URL}/api/tracks/${musicId}/audio`;
}

/** URL for the lazily-generated preset preview thumbnail (120×90 JPEG). */
export function presetPreviewUrl(presetId: string): string {
  return `${BASE_URL}/api/presets/${presetId}/preview`;
}
