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
  bpm?: number;
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
  caption_style?: string;
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
  /** Nazwa paczki mixów (np. "moje hype mixy edycja 5") — eksporty w /exports/slug. */
  pack_name?: string;
  platforms?: string[];
  preset_id?: string;
  caption_styles?: string[];
  video_duration?: number;
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
  hook_id?: string; // id pojedynczego hooka
  hook_folder_id?: string; // mood id — losowy hook z tego folderu na każdy wariant
  /** Tekst hooka na górze kadru przez cały czas (POV/CTA). Gdy brak — backend używa wybranego hooka (single/folder). */
  text_hook?: string;
  /** Font hooka: "impact" | "oswald" | "montserrat" | "arial". */
  hook_font?: string;
  /** Kolor tekstu hooka (hex np. #FFFFFF). */
  hook_color?: string;
  /** Cień tekstu hooka 0–6. */
  hook_shadow?: number;
  /** Cumulative words: Hey → Hey brother → Hey brother There's… (when display is 1/2/3 words). */
  caption_concat_words?: boolean;
  /** Custom fade-in in ms (text entering). Used when caption_animation is "fade". */
  caption_fade_in_ms?: number;
  /** Custom fade-out in ms (text exiting). Used when enter or exit animation is "fade". */
  caption_fade_out_ms?: number;
  /** ASS outline width 0–12. */
  caption_outline?: number;
  /** ASS shadow depth 0–6. */
  caption_shadow?: number;
  /** Luminous glow: outline colour = text colour (white halo). */
  caption_glow?: boolean;
  /** Text enter animation: "pop" | "bounce" | "fade" | "none". */
  caption_animation_enter?: string;
  /** Text exit animation: "pop" | "bounce" | "fade" | "none". */
  caption_animation_exit?: string;
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

/** Bulk import hooks (e.g. from CSV). Returns created records. */
export async function importHooks(hooks: Array<{ text: string; mood_id?: string }>): Promise<{
  created: HookRecord[];
  count: number;
}> {
  return apiFetch<{ created: HookRecord[]; count: number }>("/api/hooks/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hooks }),
  });
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface PresetConfig {
  captionStyle: "bold_center" | "karaoke" | "karaoke_pill" | "minimal_clean";
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
  captionOutline?: number;
  captionShadow?: number;
  captionGlow?: boolean;
  captionDisplayMode?: string;
  captionPosition?: string;
  captionConcatWords?: boolean;
  captionFadeInMs?: number;
  captionFadeOutMs?: number;
  captionFont?: string;
  captionFontSize?: number;
  captionBoxBackground?: boolean;
  captionWordsPerLine?: number;
  textHook?: string;
  flashOnDrop?: boolean;
  freezeOnDrop?: boolean;
  filmGrain?: boolean;
  vignette?: boolean;
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

export async function deletePreset(id: string): Promise<void> {
  return apiFetch<void>(`/api/presets/${id}`, { method: "DELETE" });
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
  config: Record<string, unknown> | CustomTextConfig;
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

/** Fetch cached transcription only. Does NOT run Whisper. Returns null if no cache. */
export async function getCachedTranscription(
  musicId: string,
): Promise<TranscriptionResponse | null> {
  try {
    return await apiFetch<TranscriptionResponse>(`/api/transcribe/${encodeURIComponent(musicId)}`, {
      method: "GET",
    });
  } catch {
    return null;
  }
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

/** Persist edited transcription (e.g. after word-by-word edit in Studio). */
export async function updateTranscription(
  musicId: string,
  segments: Array<{ start: number; end: number; text: string }>,
  fullText?: string,
): Promise<TranscriptionResponse> {
  return apiFetch<TranscriptionResponse>("/api/transcribe", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      music_id: musicId,
      segments,
      ...(fullText !== undefined ? { full_text: fullText } : {}),
    }),
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
