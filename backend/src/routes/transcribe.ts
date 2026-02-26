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

// ── POST /api/transcribe ──────────────────────────────────
// Returns cached result if already transcribed, otherwise runs Whisper and saves.

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
