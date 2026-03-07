import { Router } from "express";
import { transcribeAudio } from "../services/captions.js";
import { musicFile } from "../utils/helpers.js";
import { getVideoDuration } from "../services/videoAssembler.js";
import {
  saveTranscription,
  getTranscription,
  saveTrack,
  getAllTracks,
} from "../utils/db.js";

export const transcribeRouter = Router();

// ── GET /api/transcribe/:music_id ─────────────────────────
// Returns cached transcription only. Does NOT run Whisper. 404 if no cache.
// Use this on app load to hydrate state; use POST only when user explicitly requests transcription.
transcribeRouter.get("/transcribe/:music_id", (req, res) => {
  const music_id = req.params.music_id;
  if (!music_id) return res.status(400).json({ error: "music_id required" });
  const cached = getTranscription(music_id);
  if (!cached) return res.status(404).json({ error: "No transcription for this track" });
  return res.json({
    music_id,
    segments: cached.segments,
    full_text: cached.fullText,
    duration: cached.duration,
    cached: true,
  });
});

// ── POST /api/transcribe ──────────────────────────────────
// Returns cached result if already transcribed, otherwise runs Whisper and saves.
// Call only when user selects a track and we need transcription (no cache) or when user clicks "Transkrybuj ponownie" (force).

transcribeRouter.post("/transcribe", async (req, res) => {
  const { music_id, force = false } = req.body as {
    music_id?: string;
    force?: boolean;
  };
  if (!music_id) return res.status(400).json({ error: "music_id required" });

  let filePath: string;
  try {
    filePath = musicFile(music_id);
  } catch (e: unknown) {
    return res.status(404).json({ error: (e as Error).message });
  }

  // Return cached transcription unless force refresh requested
  if (!force) {
    const cached = getTranscription(music_id);
    if (cached) {
      console.log(
        `[transcribe] cache hit for ${music_id} (${cached.segments.length} segments)`,
      );
      return res.json({
        music_id,
        segments: cached.segments,
        full_text: cached.fullText,
        duration: cached.duration,
        cached: true,
      });
    }
  }

  try {
    const [segments, duration] = await Promise.all([
      transcribeAudio(filePath),
      getVideoDuration(filePath),
    ]);

    const fullText = segments.map((s) => s.text).join(" ");
    const dur = Math.round(duration * 100) / 100;

    // Persist to db
    saveTranscription({
      musicId: music_id,
      segments,
      fullText,
      duration: dur,
      createdAt: new Date().toISOString(),
    });

    // Also update track duration in db
    const tracks = getAllTracks();
    const track = tracks.find((t) => t.id === music_id);
    if (track) saveTrack({ ...track, duration: dur });

    res.json({
      music_id,
      segments,
      full_text: fullText,
      duration: dur,
      cached: false,
    });
  } catch (e: unknown) {
    console.error("[transcribe]", e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── PUT /api/transcribe ───────────────────────────────────
// Updates existing transcription (e.g. after user edits word-by-word in Studio).
// Body: { music_id, segments[, full_text] }. Persists to DB so edits survive refresh.

transcribeRouter.put("/transcribe", (req, res) => {
  const { music_id, segments: rawSegments, full_text: providedFullText } = req.body as {
    music_id?: string;
    segments?: Array<{ start: number; end: number; text: string }>;
    full_text?: string;
  };
  if (!music_id) return res.status(400).json({ error: "music_id required" });
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return res.status(400).json({ error: "segments array is required and must not be empty" });
  }

  const existing = getTranscription(music_id);
  if (!existing) {
    return res.status(404).json({ error: "No transcription found for this track; run POST /transcribe first" });
  }

  const segments = rawSegments.map((s) => ({
    start: Number(s.start),
    end: Number(s.end),
    text: typeof s.text === "string" ? s.text.trim() : "",
  })).filter((s) => s.text !== "");

  const fullText = typeof providedFullText === "string" && providedFullText.trim() !== ""
    ? providedFullText.trim()
    : segments.map((s) => s.text).join(" ");

  saveTranscription({
    musicId: music_id,
    segments,
    fullText,
    duration: existing.duration,
    createdAt: existing.createdAt,
  });

  res.json({
    music_id,
    segments,
    full_text: fullText,
    duration: existing.duration,
    updated: true,
  });
});
