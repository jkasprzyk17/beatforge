/**
 * Studio — Kashie-style 2-column layout
 *
 * Left (scrollable):
 *   1. Audio — wybierz z biblioteki lub uploaduj, auto-transcribe
 *   2. Transcribe Lyrics — edytowalne, odświeżalne, progress bar
 *   3. Choose Collection — grid kolekcji klipów
 *   4. Lyric Style — style tekstu + color picker
 *
 * Right (sticky):
 *   Phone preview + generate button
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../context/AppContext";
import type {
  LyricStyle,
  Collection,
  MoodFolder,
  Preset,
} from "../context/AppContext";
import {
  uploadMusic,
  transcribeTrack,
  generatePreview,
  generateBatch,
  watchJob,
  absoluteUrl,
  presetPreviewUrl,
} from "../lib/api";
import type { JobMetadata, JobOutput } from "../lib/api";

interface Props {
  onGoToLibrary: () => void;
  onGoToClips: () => void;
}

// ── Caption font options ──────────────────────────────────
const CAPTION_FONTS: { id: string; label: string; cssFont: string }[] = [
  { id: "impact",     label: "Impact",     cssFont: "Impact, 'Arial Black', sans-serif" },
  { id: "oswald",     label: "Oswald",     cssFont: "'Oswald', 'Arial Narrow', sans-serif" },
  { id: "montserrat", label: "Montserrat", cssFont: "'Montserrat', 'Trebuchet MS', sans-serif" },
  { id: "arial",      label: "Arial",      cssFont: "Arial, sans-serif" },
];

// ── Output platform options ───────────────────────────────
const PLATFORM_OPTIONS: { id: string; emoji: string; label: string; shortLabel: string }[] = [
  { id: "tiktok",  emoji: "🎵", label: "TikTok",         shortLabel: "TikTok" },
  { id: "reels",   emoji: "📸", label: "Instagram Reels", shortLabel: "Reels"  },
  { id: "shorts",  emoji: "▶️", label: "YouTube Shorts",  shortLabel: "Shorts" },
  { id: "stories", emoji: "💬", label: "Instagram Stories", shortLabel: "Stories" },
];
// Default "All Platforms" set — Stories excluded (15 s limit is very different)
const ALL_BATCH_PLATFORMS = ["tiktok", "reels", "shorts"];

// ── Lyric style definitions ───────────────────────────────
const LYRIC_STYLES: {
  id: LyricStyle;
  label: string;
  preview: string;
  ffmpeg: string;
}[] = [
  {
    id: "brat",
    label: "BRAT",
    preview:
      "font-weight:900;letter-spacing:-0.05em;text-transform:uppercase;font-size:1rem",
    ffmpeg: "bold_center",
  },
  {
    id: "caps",
    label: "CAPS",
    preview: "text-transform:uppercase;letter-spacing:0.15em;font-size:0.85rem",
    ffmpeg: "bold_center",
  },
  {
    id: "statement",
    label: "Statement",
    preview: "font-size:1.1rem;font-weight:800;font-style:italic",
    ffmpeg: "bold_center",
  },
  {
    id: "classic",
    label: "Classic",
    preview: "font-size:0.85rem;font-weight:400",
    ffmpeg: "minimal_clean",
  },
  {
    id: "simple",
    label: "Simple",
    preview: "font-size:0.82rem;font-weight:300;letter-spacing:0.03em",
    ffmpeg: "minimal_clean",
  },
  {
    id: "bold",
    label: "Bold",
    preview: "font-size:0.95rem;font-weight:800",
    ffmpeg: "bold_center",
  },
];

const PRESET_COLORS = [
  "#FFFFFF",
  "#FFFF00",
  "#FF3B3B",
  "#3BFF8A",
  "#3BB5FF",
  "#FF8C3B",
  "#FF3BFF",
  "#000000",
];

let _uid = 1;
const uid = () => `${Date.now()}_${_uid++}`;
const fmtDur = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtSize = (b: number) =>
  b < 1048576
    ? `${(b / 1024).toFixed(0)} KB`
    : `${(b / 1048576).toFixed(1)} MB`;

export default function Studio({ onGoToLibrary, onGoToClips }: Props) {
  const {
    tracks,
    collections,
    moods,
    presets,
    studioTrackId,
    studioCollectionId,
    studioPresetId,
    studioLyricStyle,
    studioLyricColor,
    studioLyricActiveColor,
    studioMoodId,
    setStudioTrack,
    setStudioCollection,
    setStudioPreset,
    setStudioLyricStyle,
    setStudioLyricColor,
    setStudioLyricActiveColor,
    setStudioMood,
    transcriptions,
    setTranscription,
    addTrack,
  } = useApp();

  // Local mood filter for the collection grid in Studio
  const [colMoodFilter, setColMoodFilter] = useState<string>("all");

  const track = tracks.find((t) => t.id === studioTrackId) ?? null;
  const collection =
    collections.find((c) => c.id === studioCollectionId) ?? null;

  // ── Transcription state ──────────────────────────────────
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptErr, setTranscriptErr] = useState<string | null>(null);
  const [editedText, setEditedText] = useState("");
  const [lyricsOpen, setLyricsOpen] = useState(false); // collapsed by default

  const currentSegments = studioTrackId
    ? (transcriptions[studioTrackId] ?? null)
    : null;
  const isWordMode = currentSegments?.[0]?.word === true;
  const fullText = currentSegments?.map((s) => s.text).join(" ") ?? "";

  // Word editor state (derived from segments, locally editable)
  const [wordEntries, setWordEntries] = useState<WordEntry[]>([]);

  useEffect(() => {
    if (fullText) setEditedText(fullText);
  }, [fullText]);

  useEffect(() => {
    if (currentSegments && isWordMode) {
      setWordEntries(
        currentSegments.map((s, i) => ({
          id: `w${i}_${s.start}`,
          text: s.text,
          start: s.start,
          end: s.end,
        })),
      );
    }
  }, [currentSegments]);

  const handleTranscribe = async (force = false) => {
    if (!track) return;
    if (currentSegments && !force) {
      setEditedText(fullText);
      return;
    }
    setTranscribing(true);
    setTranscriptErr(null);
    try {
      const res = await transcribeTrack(track.musicId);
      setTranscription(track.musicId, res.segments);
      setEditedText(res.full_text);
    } catch (e: unknown) {
      setTranscriptErr(e instanceof Error ? e.message : "Błąd transkrypcji.");
    } finally {
      setTranscribing(false);
    }
  };

  // Auto-transcribe when track selected and no cached result — fire once per track change
  const autoTranscribedRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      track &&
      !currentSegments &&
      !transcribing &&
      autoTranscribedRef.current !== track.id
    ) {
      autoTranscribedRef.current = track.id;
      handleTranscribe();
    }
  }, [studioTrackId]);

  // ── Upload audio from PC ─────────────────────────────────
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [audioUploading, setAudioUploading] = useState(false);

  const handleAudioFile = async (file: File) => {
    const allowed = [".mp3", ".wav", ".aac", ".flac", ".m4a"];
    if (!allowed.some((e) => file.name.toLowerCase().endsWith(e))) return;
    setAudioUploading(true);
    try {
      const res = await uploadMusic(file);
      const newTrack = {
        id: res.music_id,
        name: file.name.replace(/\.[^.]+$/, ""),
        size: file.size,
        musicId: res.music_id,
        uploadedAt: new Date(),
      };
      addTrack(newTrack);
      setStudioTrack(res.music_id);
    } catch {
    } finally {
      setAudioUploading(false);
    }
  };

  // ── Preview + batch ──────────────────────────────────────
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBpm, setPreviewBpm] = useState<number | null>(null);
  const [previewBeats, setPreviewBeats] = useState<number[]>([]);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const [batchJobId, setBatchJobId] = useState<string | null>(null);
  const [batchJob, setBatchJob] = useState<JobMetadata | null>(null);
  const [batchErr, setBatchErr] = useState<string | null>(null);
  const [batchSeed, setBatchSeed] = useState<string>("");
  const [studioFont, setStudioFont] = useState<string>("arial");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(["tiktok"]);

  const togglePlatform = (id: string) => {
    setSelectedPlatforms((prev) => {
      if (prev.includes(id)) {
        // Prevent deselecting the last platform
        return prev.length > 1 ? prev.filter((p) => p !== id) : prev;
      }
      return [...prev, id];
    });
  };

  useEffect(() => {
    if (!batchJobId) return;
    // SSE — server pushes every 800 ms; no client-side polling needed
    return watchJob(
      batchJobId,
      (job) => setBatchJob(job),
      (job) => setBatchJob(job),
    );
  }, [batchJobId]);

  const clipsId = collection?.clips[0]?.clipsId ?? null;
  const ready = !!track && !!collection && !!clipsId;
  const ffmpegStyle =
    LYRIC_STYLES.find((s) => s.id === studioLyricStyle)?.ffmpeg ??
    "bold_center";
  const activePreset = presets.find((p) => p.id === studioPresetId) ?? null;

  const handlePreview = async () => {
    if (!ready) return;
    setPreviewLoading(true);
    setPreviewErr(null);
    setPreviewUrl(null);
    try {
      const r = await generatePreview({
        music_id: track!.musicId,
        clips_id: clipsId!,
        caption_style: ffmpegStyle as
          | "bold_center"
          | "karaoke"
          | "minimal_clean",
        preview_duration: 5,
      });
      setPreviewUrl(absoluteUrl(r.preview_url));
      setPreviewBpm(r.bpm);
      setPreviewBeats(r.beats ?? []);
    } catch (e: unknown) {
      setPreviewErr(e instanceof Error ? e.message : "Błąd podglądu.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!ready) return;
    setBatchErr(null);
    setBatchJob(null);
    setBatchJobId(null);
    try {
      const segsToSend =
        isWordMode && wordEntries.length > 0
          ? wordEntries.map(({ text, start, end }) => ({ text, start, end }))
          : currentSegments?.map(({ text, start, end }) => ({
              text,
              start,
              end,
            }));

      const parsedSeed = batchSeed.trim() !== "" ? parseInt(batchSeed, 10) : undefined;

      const r = await generateBatch({
        music_id: track!.musicId,
        clips_id: clipsId!,
        platforms: selectedPlatforms,
        preset_id: studioPresetId ?? undefined,
        caption_color: studioLyricColor,
        caption_active_color: studioLyricActiveColor,
        caption_font: studioFont !== "arial" ? studioFont : undefined,
        mood_id: studioMoodId ?? collection?.folderId ?? undefined,
        duration_mode: "auto",
        batch_count: 1,
        segments: segsToSend,
        seed: !isNaN(parsedSeed!) ? parsedSeed : undefined,
      });
      setBatchJobId(r.job_id);
    } catch (e: unknown) {
      setBatchErr(e instanceof Error ? e.message : "Błąd generowania.");
    }
  };

  return (
    <div
      className="fade-in"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* ── 2-column layout ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* ════ LEFT — config panel ════ */}
        <div
          style={{
            flex: 2,
            overflowY: "auto",
            padding: "1.5rem",
            display: "flex",
            flexDirection: "column",
            gap: "1px",
            borderRight: "1px solid var(--border)",
          }}
        >
          {/* ── 1. Audio ── */}
          <Section title="Upload Your Audio" step={1}>
            {track ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1rem",
                  background: "var(--bg-3)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "0.75rem 1rem",
                }}
              >
                <div style={{ fontSize: "1.4rem" }}>🎵</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p
                    className="truncate"
                    style={{ fontWeight: 600, fontSize: "0.9rem" }}
                  >
                    {track.name}
                  </p>
                  <p className="text-xs text-3">
                    {track.duration ? fmtDur(track.duration) : "—"} ·{" "}
                    {fmtSize(track.size)}
                  </p>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setStudioTrack(null);
                    setPreviewUrl(null);
                  }}
                >
                  Change File
                </button>
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                {/* From library */}
                {tracks.length > 0 && (
                  <div>
                    <p className="label" style={{ marginBottom: "0.5rem" }}>
                      Z biblioteki
                    </p>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.4rem",
                        maxHeight: 160,
                        overflowY: "auto",
                      }}
                    >
                      {tracks.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setStudioTrack(t.id)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.75rem",
                            background: "var(--bg-3)",
                            border: "1px solid var(--border)",
                            borderRadius: "var(--radius)",
                            padding: "0.6rem 0.85rem",
                            cursor: "pointer",
                            transition: "all var(--t)",
                            textAlign: "left",
                          }}
                          onMouseEnter={(e) =>
                            ((
                              e.currentTarget as HTMLElement
                            ).style.borderColor = "var(--purple)")
                          }
                          onMouseLeave={(e) =>
                            ((
                              e.currentTarget as HTMLElement
                            ).style.borderColor = "var(--border)")
                          }
                        >
                          <span>🎵</span>
                          <span
                            className="truncate"
                            style={{
                              fontSize: "0.85rem",
                              fontWeight: 500,
                              flex: 1,
                            }}
                          >
                            {t.name}
                          </span>
                          <span className="text-xs text-3">
                            {fmtSize(t.size)}
                          </span>
                        </button>
                      ))}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "center",
                        margin: "0.75rem 0",
                      }}
                    >
                      <div
                        style={{
                          flex: 1,
                          height: 1,
                          background: "var(--border)",
                        }}
                      />
                      <span className="text-xs text-3">lub</span>
                      <div
                        style={{
                          flex: 1,
                          height: 1,
                          background: "var(--border)",
                        }}
                      />
                    </div>
                  </div>
                )}
                {/* Upload from PC */}
                <input
                  ref={audioInputRef}
                  type="file"
                  accept=".mp3,.wav,.aac,.flac,.m4a"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (e.target.files?.[0]) handleAudioFile(e.target.files[0]);
                  }}
                />
                <button
                  className="btn btn-ghost w-full"
                  onClick={() => audioInputRef.current?.click()}
                  disabled={audioUploading}
                  style={{ justifyContent: "center", borderStyle: "dashed" }}
                >
                  {audioUploading ? (
                    <>
                      <div
                        className="spinner"
                        style={{ width: 14, height: 14, borderWidth: 2 }}
                      />{" "}
                      Wgrywa…
                    </>
                  ) : (
                    "⬆ Wgraj plik audio z PC"
                  )}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={onGoToLibrary}
                  style={{ justifyContent: "center" }}
                >
                  → Otwórz bibliotekę
                </button>
              </div>
            )}
          </Section>

          {/* ── 2. Transcribe Lyrics (collapsible) ── */}
          {track && (
            <div
              style={{
                padding: "1.1rem 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              {/* Header row — always visible */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.55rem",
                  }}
                >
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      background: "var(--purple-dim)",
                      border: "1px solid rgba(139,92,246,0.35)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.62rem",
                      fontWeight: 800,
                      color: "#c4b5fd",
                      flexShrink: 0,
                    }}
                  >
                    2
                  </div>
                  <p style={{ fontWeight: 700, fontSize: "0.875rem" }}>
                    Transcribe Lyrics
                  </p>
                  <span
                    className="badge badge-gray"
                    style={{ fontSize: "0.62rem" }}
                  >
                    Optional
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                  }}
                >
                  {currentSegments && !transcribing && (
                    <span
                      style={{ fontSize: "0.72rem", color: "var(--text-3)" }}
                    >
                      Saved
                    </span>
                  )}
                  {currentSegments && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setLyricsOpen((v) => !v)}
                    >
                      {lyricsOpen ? "Close" : "Edit"}
                    </button>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => handleTranscribe(true)}
                    disabled={transcribing}
                    title="Transkrybuj ponownie"
                    style={{ padding: "0.25rem 0.4rem" }}
                  >
                    {transcribing ? (
                      <div
                        className="spinner"
                        style={{ width: 12, height: 12, borderWidth: 2 }}
                      />
                    ) : (
                      <span style={{ fontSize: "0.85rem" }}>↻</span>
                    )}
                  </button>
                </div>
              </div>

              {/* Compact preview — always visible when transcribed */}
              {currentSegments && !transcribing && (
                <div
                  onClick={() => setLyricsOpen(true)}
                  style={{
                    marginTop: "0.65rem",
                    padding: "0.6rem 0.75rem",
                    background: "var(--bg-3)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    fontSize: "0.82rem",
                    lineHeight: 1.6,
                    color: "var(--text-2)",
                    maxHeight: lyricsOpen ? "none" : 52,
                    overflow: "hidden",
                    cursor: lyricsOpen ? "default" : "pointer",
                    position: "relative",
                    transition: "max-height 0.2s",
                  }}
                >
                  {editedText || (
                    <span className="text-3">Brak transkrypcji…</span>
                  )}
                  {!lyricsOpen && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: 24,
                        background: "linear-gradient(transparent, var(--bg-3))",
                      }}
                    />
                  )}
                </div>
              )}

              {/* Transcribing state */}
              {transcribing && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                    marginTop: "0.65rem",
                  }}
                >
                  <div className="spinner" />
                  <span className="text-sm text-2 pulse">
                    Whisper transkrybuje…
                  </span>
                </div>
              )}

              {transcriptErr && (
                <p
                  style={{
                    color: "var(--red)",
                    fontSize: "0.82rem",
                    marginTop: "0.5rem",
                  }}
                >
                  ⚠ {transcriptErr}
                </p>
              )}

              {/* Expanded editor — Word-by-Word Timestamps */}
              {lyricsOpen && currentSegments && !transcribing && (
                <div style={{ marginTop: "0.85rem" }}>
                  {/* Editable full text */}
                  <p className="label" style={{ marginBottom: "0.4rem" }}>
                    Edit Lyrics
                  </p>
                  <textarea
                    className="textarea"
                    value={editedText}
                    onChange={(e) => setEditedText(e.target.value)}
                    style={{
                      minHeight: 80,
                      fontSize: "0.85rem",
                      lineHeight: 1.6,
                      marginBottom: "0.25rem",
                    }}
                  />
                  <p
                    className="text-xs text-3"
                    style={{ marginBottom: "0.85rem" }}
                  >
                    Edits here sync with the timing view below.
                  </p>

                  {/* Word-by-Word grid */}
                  <p
                    style={{
                      fontWeight: 700,
                      fontSize: "0.8rem",
                      marginBottom: "0.6rem",
                    }}
                  >
                    Word-by-Word Timestamps
                  </p>

                  {isWordMode ? (
                    <WordTimestampEditor
                      words={wordEntries}
                      onChange={(entries) => {
                        setWordEntries(entries);
                        setEditedText(entries.map((e) => e.text).join(" "));
                      }}
                    />
                  ) : (
                    <p className="text-xs text-3">
                      Segment-level only — brak word timestamps.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── 3. Choose Collection ── */}
          <Section
            title="Choose Video Style"
            step={3}
            action={
              <button className="btn btn-ghost btn-sm" onClick={onGoToClips}>
                + Nowa kolekcja
              </button>
            }
          >
            {collections.length === 0 ? (
              <div style={{ textAlign: "center", padding: "1.5rem 0" }}>
                <p
                  className="text-sm text-3"
                  style={{ marginBottom: "0.75rem" }}
                >
                  Nie masz jeszcze żadnych kolekcji klipów
                </p>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={onGoToClips}
                >
                  → Wgraj klipy MP4
                </button>
              </div>
            ) : (
              <>
                {/* Mood filter pills */}
                <div
                  style={{
                    display: "flex",
                    gap: "0.3rem",
                    flexWrap: "wrap",
                    marginBottom: "0.75rem",
                  }}
                >
                  <MoodPill
                    label="Wszystkie"
                    emoji="🗂"
                    color="var(--purple)"
                    active={colMoodFilter === "all"}
                    onClick={() => setColMoodFilter("all")}
                  />
                  {moods
                    .filter((m) => collections.some((c) => c.folderId === m.id))
                    .map((m) => (
                      <MoodPill
                        key={m.id}
                        label={m.label}
                        emoji={m.emoji}
                        color={m.color}
                        active={colMoodFilter === m.id}
                        onClick={() => setColMoodFilter(m.id)}
                      />
                    ))}
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(110px, 1fr))",
                    gap: "0.6rem",
                  }}
                >
                  {collections
                    .filter(
                      (c) =>
                        colMoodFilter === "all" || c.folderId === colMoodFilter,
                    )
                    .map((col) => (
                      <CollectionCard
                        key={col.id}
                        collection={col}
                        mood={moods.find((m) => m.id === col.folderId)}
                        selected={studioCollectionId === col.id}
                        onSelect={() => setStudioCollection(col.id)}
                      />
                    ))}
                </div>
              </>
            )}
          </Section>

          {/* ── 4. Preset ── */}
          <Section title="Video Preset" step={4} badge="Optional">
            {presets.length === 0 ? (
              <p className="text-sm text-3">Loading presets…</p>
            ) : (
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                <button
                  onClick={() => setStudioPreset(null)}
                  style={{
                    padding: "0.4rem 0.75rem",
                    borderRadius: "var(--radius)",
                    fontSize: "0.78rem",
                    border: `1.5px solid ${studioPresetId === null ? "var(--purple)" : "var(--border)"}`,
                    background:
                      studioPresetId === null
                        ? "var(--purple-dim)"
                        : "var(--bg-3)",
                    cursor: "pointer",
                    transition: "all var(--t)",
                    color:
                      studioPresetId === null ? "#c4b5fd" : "var(--text-2)",
                  }}
                >
                  None
                </button>
                {presets.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setStudioPreset(p.id)}
                    title={[
                      p.config.clipCutStrategy === "beat"
                        ? "Beat cuts"
                        : "Random cuts",
                      p.config.zoomPunch ? "Zoom" : null,
                      p.config.transition !== "none"
                        ? p.config.transition
                        : null,
                      p.config.colorGrade ?? null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    style={{
                      padding: 0,
                      borderRadius: "var(--radius)",
                      fontSize: "0.78rem",
                      border: `1.5px solid ${studioPresetId === p.id ? "var(--purple)" : "var(--border)"}`,
                      background: "var(--bg-3)",
                      cursor: "pointer",
                      transition: "all var(--t)",
                      color:
                        studioPresetId === p.id ? "#c4b5fd" : "var(--text)",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "stretch",
                      overflow: "hidden",
                      width: 90,
                      flexShrink: 0,
                      outline: studioPresetId === p.id
                        ? "2px solid var(--purple)"
                        : "none",
                      outlineOffset: 1,
                    }}
                  >
                    {/* Thumbnail */}
                    <img
                      src={presetPreviewUrl(p.id)}
                      alt=""
                      loading="lazy"
                      style={{
                        width: "100%",
                        height: 50,
                        objectFit: "cover",
                        display: "block",
                        background: "var(--bg-4)",
                      }}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                    {/* Label */}
                    <span
                      style={{
                        padding: "0.3rem 0.5rem",
                        display: "flex",
                        alignItems: "center",
                        gap: "0.3rem",
                        fontSize: "0.72rem",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          flexShrink: 0,
                          background: p.config.captionColor,
                          border: "1px solid rgba(255,255,255,0.2)",
                        }}
                      />
                      {p.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {activePreset && (
              <div
                style={{
                  marginTop: "0.6rem",
                  padding: "0.5rem 0.7rem",
                  background: "var(--bg-3)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  fontSize: "0.72rem",
                  color: "var(--text-3)",
                  display: "flex",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                {activePreset.config.clipCutStrategy === "beat" && (
                  <span>🥁 Beat cuts</span>
                )}
                {activePreset.config.zoomPunch && <span>🔍 Zoom punch</span>}
                {activePreset.config.transition !== "none" && (
                  <span>⚡ {activePreset.config.transition}</span>
                )}
                {activePreset.config.colorGrade && (
                  <span>🎨 {activePreset.config.colorGrade}</span>
                )}
                {activePreset.config.letterbox && <span>🎬 Letterbox</span>}
                {activePreset.config.slowMotion && <span>🐌 Slo-Mo</span>}
                {activePreset.config.maxDuration && (
                  <span>⏱ max {activePreset.config.maxDuration}s</span>
                )}
              </div>
            )}
          </Section>

          {/* ── 5. Lyric Style ── */}
          <Section title="Customize Lyrics" step={5}>
            <div style={{ marginBottom: "1rem" }}>
              <p className="label" style={{ marginBottom: "0.5rem" }}>
                Style
              </p>
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                {LYRIC_STYLES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setStudioLyricStyle(s.id)}
                    style={{
                      padding: "0.5rem 0.85rem",
                      borderRadius: "var(--radius)",
                      border: `1.5px solid ${studioLyricStyle === s.id ? "var(--purple)" : "var(--border)"}`,
                      background:
                        studioLyricStyle === s.id
                          ? "var(--purple-dim)"
                          : "var(--bg-3)",
                      cursor: "pointer",
                      transition: "all var(--t)",
                      ...Object.fromEntries(
                        s.preview
                          .split(";")
                          .filter(Boolean)
                          .map((r) => {
                            const [k, v] = r.split(":");
                            const key = k
                              .trim()
                              .replace(/-([a-z])/g, (_: string, c: string) =>
                                c.toUpperCase(),
                              );
                            return [key, v?.trim()];
                          }),
                      ),
                      color:
                        studioLyricStyle === s.id ? "#c4b5fd" : "var(--text)",
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="label" style={{ marginBottom: "0.5rem" }}>
                Color
              </p>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setStudioLyricColor(c)}
                    title={c}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      background: c,
                      border:
                        studioLyricColor === c
                          ? "2.5px solid var(--purple)"
                          : "1.5px solid var(--border)",
                      boxShadow:
                        studioLyricColor === c
                          ? "0 0 0 2px var(--purple-dim)"
                          : "none",
                      cursor: "pointer",
                      transition: "all var(--t)",
                    }}
                  />
                ))}
                {/* Custom color */}
                <div style={{ position: "relative" }}>
                  <input
                    type="color"
                    value={studioLyricColor}
                    onChange={(e) => setStudioLyricColor(e.target.value)}
                    style={{
                      opacity: 0,
                      position: "absolute",
                      width: 26,
                      height: 26,
                      cursor: "pointer",
                    }}
                  />
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      background:
                        "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
                      border: "1.5px solid var(--border)",
                      cursor: "pointer",
                    }}
                  />
                </div>
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-2)",
                    fontFamily: "monospace",
                    background: "var(--bg-3)",
                    padding: "0.2rem 0.5rem",
                    borderRadius: "var(--radius)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {studioLyricColor.toUpperCase()}
                </span>
              </div>
            </div>

            {/* Karaoke highlight color */}
            <div style={{ marginTop: "0.85rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.5rem" }}>
                <p className="label">Highlight Color</p>
                <span className="badge badge-gray" style={{ fontSize: "0.6rem" }}>karaoke</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                {["#FFFF00", "#FF0055", "#00FFAA", "#3BB5FF", "#FF8C00", "#FFFFFF", "#FF3BFF"].map((c) => (
                  <button
                    key={c}
                    onClick={() => setStudioLyricActiveColor(c)}
                    title={c}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      background: c,
                      border:
                        studioLyricActiveColor === c
                          ? "2.5px solid var(--purple)"
                          : "1.5px solid var(--border)",
                      boxShadow:
                        studioLyricActiveColor === c
                          ? "0 0 0 2px var(--purple-dim)"
                          : "none",
                      cursor: "pointer",
                      transition: "all var(--t)",
                    }}
                  />
                ))}
                {/* Custom active color */}
                <div style={{ position: "relative" }}>
                  <input
                    type="color"
                    value={studioLyricActiveColor}
                    onChange={(e) => setStudioLyricActiveColor(e.target.value)}
                    style={{ opacity: 0, position: "absolute", width: 26, height: 26, cursor: "pointer" }}
                  />
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
                      border: "1.5px solid var(--border)",
                      cursor: "pointer",
                    }}
                  />
                </div>
                {/* Live preview swatch */}
                <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                  <div style={{
                    padding: "0.15rem 0.55rem",
                    borderRadius: 4,
                    background: "var(--bg-4)",
                    border: "1px solid var(--border)",
                    fontSize: "0.72rem",
                    fontWeight: 700,
                    color: studioLyricActiveColor,
                    fontFamily: "monospace",
                    letterSpacing: "0.03em",
                  }}>
                    {studioLyricActiveColor.toUpperCase()}
                  </div>
                </div>
              </div>
            </div>

            {/* ── Font picker ── */}
            <div style={{ marginTop: "0.85rem" }}>
              <p className="label" style={{ marginBottom: "0.5rem" }}>Font</p>
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                {CAPTION_FONTS.map((f) => {
                  const active = studioFont === f.id;
                  return (
                    <button
                      key={f.id}
                      onClick={() => setStudioFont(f.id)}
                      style={{
                        padding: "0.45rem 0.9rem",
                        borderRadius: "var(--radius)",
                        border: `1.5px solid ${active ? "var(--purple)" : "var(--border)"}`,
                        background: active ? "var(--purple-dim)" : "var(--bg-3)",
                        cursor: "pointer",
                        fontFamily: f.cssFont,
                        fontWeight: 700,
                        fontSize: "0.85rem",
                        color: active ? "#c4b5fd" : "var(--text)",
                        transition: "all var(--t)",
                        letterSpacing: f.id === "impact" ? "-0.02em" : f.id === "oswald" ? "0.03em" : "normal",
                      }}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </Section>

        </div>

        {/* ════ RIGHT — video editor panel ════ */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            borderLeft: "1px solid var(--border)",
            background: "var(--bg-2)",
            overflow: "hidden",
          }}
        >
          {/* ── Scrollable area: video + timeline ── */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
            <PhonePreview
              url={previewUrl}
              bpm={previewBpm}
              loading={previewLoading}
              lyricText={editedText.slice(0, 60) || null}
              lyricStyle={studioLyricStyle}
              lyricColor={studioLyricColor}
              letterbox={activePreset?.config?.letterbox ?? false}
            />
            <TimelineStrip
              segments={currentSegments ?? []}
              editedText={editedText}
              beats={previewBeats}
              trackName={track?.name ?? null}
            />
          </div>

          {/* ── Sticky CTA — always visible ── */}
          <div
            style={{
              flexShrink: 0,
              borderTop: "1px solid var(--border)",
              background: "var(--bg-2)",
            }}
          >
            {/* Errors */}
            {(previewErr || batchErr) && (
              <div
                style={{
                  margin: "0.6rem 0.75rem 0",
                  padding: "0.55rem 0.75rem",
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.22)",
                  borderRadius: "var(--radius)",
                  color: "var(--red)",
                  fontSize: "0.78rem",
                  display: "flex",
                  gap: "0.4rem",
                  alignItems: "flex-start",
                }}
              >
                <span style={{ flexShrink: 0 }}>⚠</span>
                <span>{previewErr || batchErr}</span>
              </div>
            )}

            {/* Batch job status */}
            {batchJob && (
              <div style={{ padding: "0.6rem 0.75rem 0" }}>
                <BatchStatus
                  job={batchJob}
                  onReset={() => {
                    setBatchJobId(null);
                    setBatchJob(null);
                  }}
                />
              </div>
            )}

            <div style={{ padding: "0.7rem 0.85rem 0.85rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {/* Seed + Preview row */}
              <div style={{ display: "flex", gap: "0.4rem" }}>
                {/* Seed input */}
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    background: "var(--bg-3)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    padding: "0.3rem 0.5rem",
                  }}
                >
                  <span style={{ fontSize: "0.65rem", color: "var(--text-3)", flexShrink: 0 }} title="Seed">
                    🔁
                  </span>
                  <input
                    type="number"
                    placeholder="seed"
                    value={batchSeed}
                    onChange={(e) => setBatchSeed(e.target.value)}
                    style={{
                      flex: 1,
                      background: "transparent",
                      border: "none",
                      outline: "none",
                      fontSize: "0.68rem",
                      color: batchSeed ? "var(--text)" : "var(--text-3)",
                      minWidth: 0,
                    }}
                  />
                  {batchSeed && (
                    <button
                      onClick={() => setBatchSeed("")}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", fontSize: "0.6rem", padding: 0, lineHeight: 1 }}
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* Preview 5s button */}
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handlePreview}
                  disabled={!ready || previewLoading}
                  style={{ flexShrink: 0, fontSize: "0.75rem", padding: "0 0.65rem" }}
                  title="Generate 5s preview"
                >
                  {previewLoading ? (
                    <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                  ) : (
                    "▶ 5s"
                  )}
                </button>
              </div>

              {/* ── Platform selector ── */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.4rem" }}>
                  <span style={{ fontSize: "0.62rem", color: "var(--text-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Platforms
                  </span>
                  <button
                    onClick={() => setSelectedPlatforms([...ALL_BATCH_PLATFORMS])}
                    title="TikTok + Reels + Shorts in one click"
                    style={{
                      fontSize: "0.6rem",
                      fontWeight: 700,
                      color: selectedPlatforms.length === ALL_BATCH_PLATFORMS.length &&
                             ALL_BATCH_PLATFORMS.every(p => selectedPlatforms.includes(p))
                               ? "var(--purple)"
                               : "var(--text-3)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "0.1rem 0.3rem",
                      borderRadius: 4,
                      letterSpacing: "0.03em",
                      textTransform: "uppercase",
                    }}
                  >
                    🌐 All ×{ALL_BATCH_PLATFORMS.length}
                  </button>
                </div>

                <div style={{ display: "flex", gap: "0.35rem" }}>
                  {PLATFORM_OPTIONS.map((p) => {
                    const active = selectedPlatforms.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => togglePlatform(p.id)}
                        title={p.label}
                        style={{
                          flex: 1,
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: "0.15rem",
                          padding: "0.35rem 0.2rem",
                          borderRadius: "var(--radius)",
                          border: `1.5px solid ${active ? "var(--purple)" : "var(--border)"}`,
                          background: active ? "var(--purple-dim)" : "var(--bg-3)",
                          cursor: "pointer",
                          transition: "all var(--t)",
                          position: "relative",
                        }}
                      >
                        <span style={{ fontSize: "0.9rem", lineHeight: 1 }}>{p.emoji}</span>
                        <span style={{
                          fontSize: "0.52rem",
                          fontWeight: 700,
                          color: active ? "#c4b5fd" : "var(--text-3)",
                          whiteSpace: "nowrap",
                          letterSpacing: "0.02em",
                        }}>
                          {p.shortLabel}
                        </span>
                        {active && (
                          <span style={{
                            position: "absolute",
                            top: 3,
                            right: 4,
                            width: 5,
                            height: 5,
                            borderRadius: "50%",
                            background: "var(--purple)",
                          }} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Monthly renders hint */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.4rem" }}>
                <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                <span style={{ fontSize: "0.62rem", color: "var(--text-3)", whiteSpace: "nowrap" }}>
                  Monthly renders
                </span>
                <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              </div>

              {/* ✦ GENERATE VIDEO — primary CTA */}
              <button
                onClick={handleGenerate}
                disabled={!ready || !!batchJobId}
                style={{
                  width: "100%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.4rem",
                  padding: "0.72rem 1rem",
                  borderRadius: "var(--radius)",
                  fontFamily: "inherit",
                  fontSize: "0.9rem",
                  fontWeight: 700,
                  border: "none",
                  cursor: ready && !batchJobId ? "pointer" : "not-allowed",
                  opacity: ready && !batchJobId ? 1 : 0.45,
                  background: "linear-gradient(135deg, #6366f1 0%, #3b82f6 100%)",
                  color: "#fff",
                  boxShadow: ready && !batchJobId
                    ? "0 0 28px rgba(99,102,241,0.4), 0 4px 16px rgba(0,0,0,0.35)"
                    : "none",
                  transition: "all 0.18s ease",
                  letterSpacing: "-0.01em",
                }}
                onMouseEnter={(e) => {
                  if (ready && !batchJobId)
                    (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = "";
                }}
              >
                {batchJobId && batchJob?.status !== "done" && batchJob?.status !== "error" ? (
                  <>
                    <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                    Generuję…
                  </>
                ) : selectedPlatforms.length > 1 ? (
                  <>✦ Generate ×{selectedPlatforms.length}</>
                ) : (
                  <>✦ Generate video</>
                )}
              </button>

              {!ready && (
                <p
                  style={{
                    fontSize: "0.7rem",
                    color: "var(--text-3)",
                    textAlign: "center",
                    margin: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "0.35rem",
                  }}
                >
                  <span style={{ color: "var(--orange)", fontSize: "0.65rem" }}>●</span>
                  {!track ? "Wybierz plik audio" : "Wybierz kolekcję klipów"}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Section wrapper ────────────────────────────────────── */

function Section({
  title,
  badge,
  action,
  step,
  children,
}: {
  title: string;
  badge?: string;
  action?: React.ReactNode;
  step?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "1.1rem 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.85rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
          {step != null && (
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: "var(--purple-dim)",
                border: "1px solid rgba(139,92,246,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.62rem",
                fontWeight: 800,
                color: "#c4b5fd",
                flexShrink: 0,
              }}
            >
              {step}
            </div>
          )}
          <p style={{ fontWeight: 700, fontSize: "0.875rem" }}>{title}</p>
          {badge && (
            <span className="badge badge-gray" style={{ fontSize: "0.62rem" }}>
              {badge}
            </span>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

/* ── MoodPill ───────────────────────────────────────────── */

function MoodPill({
  label,
  emoji,
  color,
  active,
  onClick,
}: {
  label: string;
  emoji: string;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "0.25rem 0.6rem",
        borderRadius: 99,
        fontSize: "0.72rem",
        fontWeight: 600,
        cursor: "pointer",
        transition: "all var(--t)",
        border: `1.5px solid ${active ? color : "var(--border)"}`,
        background: active ? `${color}22` : "var(--bg-3)",
        color: active ? color : "var(--text-3)",
      }}
    >
      {emoji} {label}
    </button>
  );
}

/* ── CollectionCard ─────────────────────────────────────── */

function CollectionCard({
  collection,
  mood,
  selected,
  onSelect,
}: {
  collection: Collection;
  mood?: MoodFolder;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      style={{
        background: selected ? "var(--purple-dim)" : "var(--bg-3)",
        border: `1.5px solid ${selected ? "var(--purple)" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        overflow: "hidden",
        cursor: "pointer",
        transition: "all var(--t)",
        padding: 0,
        textAlign: "left",
      }}
    >
      {/* Thumbnail */}
      <div
        style={{
          aspectRatio: "9/16",
          background: "var(--bg-4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "1.5rem",
          color: "var(--text-3)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {collection.thumbnailUrl ? (
          <img
            src={absoluteUrl(collection.thumbnailUrl)}
            alt={collection.name}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span>🎬</span>
        )}
        {selected && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(139,92,246,0.25)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ fontSize: "1.2rem" }}>✓</span>
          </div>
        )}
        {mood && (
          <div
            style={{
              position: "absolute",
              bottom: "0.25rem",
              left: "0.25rem",
              background: "rgba(0,0,0,0.7)",
              borderRadius: 4,
              padding: "0.1rem 0.3rem",
              fontSize: "0.55rem",
              fontWeight: 700,
              color: mood.color,
            }}
          >
            {mood.emoji}
          </div>
        )}
      </div>
      <div style={{ padding: "0.4rem 0.5rem" }}>
        <p
          className="truncate"
          style={{
            fontSize: "0.72rem",
            fontWeight: 600,
            color: selected ? "#c4b5fd" : "var(--text)",
          }}
        >
          {collection.name}
        </p>
        <p className="text-xs text-3">
          {mood ? `${mood.label} · ` : ""}
          {collection.clips.length} kl.
        </p>
      </div>
    </button>
  );
}

/* ── Phone preview ──────────────────────────────────────── */

function PhonePreview({
  url,
  bpm,
  loading,
  lyricText,
  lyricStyle,
  lyricColor,
  letterbox = false,
}: {
  url: string | null;
  bpm: number | null;
  loading: boolean;
  lyricText: string | null;
  lyricStyle: LyricStyle;
  lyricColor: string;
  letterbox?: boolean;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [showSafeZone, setShowSafeZone] = React.useState(false);
  const [playing, setPlaying] = React.useState(true);
  const [muted, setMuted] = React.useState(true);
  const [currentTime, setCurrentTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);

  const styleObj = LYRIC_STYLES.find((s) => s.id === lyricStyle);
  const inlineStyle = styleObj
    ? Object.fromEntries(
        styleObj.preview
          .split(";")
          .filter(Boolean)
          .map((r) => {
            const [k, v] = r.split(":");
            const key = k
              .trim()
              .replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
            return [key, v?.trim()];
          }),
      )
    : {};

  const fmtT = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      setPlaying(true);
    } else {
      videoRef.current.pause();
      setPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    if (videoRef.current) videoRef.current.currentTime = t;
    setCurrentTime(t);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* ── Screen area (9:16, max height so buttons stay visible) ── */}
      <div
        style={{
          width: "100%",
          aspectRatio: "9/16",
          maxHeight: "52vh",
          background: "#0a0a12",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {loading ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              gap: "0.5rem",
            }}
          >
            <div className="spinner" style={{ width: 22, height: 22 }} />
            <p style={{ fontSize: "0.6rem", color: "var(--text-3)" }} className="pulse">
              rendering…
            </p>
          </div>
        ) : url ? (
          <video
            ref={videoRef}
            src={url}
            autoPlay
            loop
            muted={muted}
            playsInline
            onTimeUpdate={() => {
              if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
            }}
            onLoadedMetadata={() => {
              if (videoRef.current) setDuration(videoRef.current.duration);
            }}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              gap: "0.4rem",
            }}
          >
            <div style={{ fontSize: "2rem", opacity: 0.1 }}>🎬</div>
            <p style={{ fontSize: "0.56rem", color: "var(--text-3)" }}>
              preview will appear here
            </p>
          </div>
        )}

        {/* Centered lyric overlay — visible when no video yet */}
        {lyricText && !url && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "8%",
              right: "8%",
              transform: "translateY(-50%)",
              textAlign: "center",
              ...inlineStyle,
              color: lyricColor,
              textShadow: "0 2px 8px rgba(0,0,0,0.9), 0 0 20px rgba(0,0,0,0.5)",
              lineHeight: 1.3,
              wordBreak: "break-word",
            }}
          >
            {lyricText}
          </div>
        )}

        {/* BPM badge */}
        {bpm && (
          <div
            style={{
              position: "absolute",
              top: "0.4rem",
              left: "0.4rem",
              background: "rgba(0,0,0,0.65)",
              backdropFilter: "blur(4px)",
              borderRadius: 6,
              padding: "0.15rem 0.4rem",
              fontSize: "0.6rem",
              fontWeight: 700,
              color: "var(--green)",
              zIndex: 10,
            }}
          >
            🥁 {bpm} BPM
          </div>
        )}

        {/* Safe-zone toggle button */}
        <button
          onClick={() => setShowSafeZone((s) => !s)}
          title="Toggle safe-zone overlay"
          style={{
            position: "absolute",
            top: "0.3rem",
            right: "0.3rem",
            background: showSafeZone ? "rgba(139,92,246,0.75)" : "rgba(0,0,0,0.45)",
            border: "none",
            borderRadius: 4,
            padding: "0.12rem 0.22rem",
            fontSize: "0.5rem",
            color: "white",
            cursor: "pointer",
            zIndex: 14,
            lineHeight: 1,
          }}
        >
          📐
        </button>

        {/* Safe-zone overlay */}
        {showSafeZone && (
          <>
            <div
              style={{
                position: "absolute", top: 0, left: 0, right: 0,
                height: "10%",
                background: "rgba(239,68,68,0.12)",
                borderBottom: "1px dashed rgba(239,68,68,0.5)",
                zIndex: 11, pointerEvents: "none",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <span style={{ fontSize: "0.38rem", color: "rgba(239,68,68,0.8)", fontWeight: 700 }}>UI</span>
            </div>
            <div
              style={{
                position: "absolute", bottom: 0, left: 0, right: 0,
                height: "22%",
                background: "rgba(239,68,68,0.12)",
                borderTop: "1px dashed rgba(239,68,68,0.5)",
                zIndex: 11, pointerEvents: "none",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <span style={{ fontSize: "0.38rem", color: "rgba(239,68,68,0.8)", fontWeight: 700 }}>UI</span>
            </div>
            <div
              style={{
                position: "absolute", top: "10%", bottom: "22%", left: 0,
                width: "5%",
                background: "rgba(239,68,68,0.08)",
                borderRight: "1px dashed rgba(239,68,68,0.4)",
                zIndex: 11, pointerEvents: "none",
              }}
            />
            <div
              style={{
                position: "absolute", top: "10%", bottom: "22%", right: 0,
                width: "5%",
                background: "rgba(239,68,68,0.08)",
                borderLeft: "1px dashed rgba(239,68,68,0.4)",
                zIndex: 11, pointerEvents: "none",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: "10%", bottom: "22%", left: "5%", right: "5%",
                border: "1px dashed rgba(255,255,255,0.3)",
                borderRadius: 2,
                zIndex: 12, pointerEvents: "none",
                display: "flex", alignItems: "flex-start", justifyContent: "flex-end",
                padding: "0.15rem",
              }}
            >
              <span
                style={{
                  fontSize: "0.38rem", color: "rgba(255,255,255,0.6)",
                  background: "rgba(0,0,0,0.55)",
                  padding: "0.08rem 0.2rem", borderRadius: 2,
                }}
              >
                safe zone
              </span>
            </div>
          </>
        )}

        {/* Letterbox bars */}
        {letterbox && (
          <>
            <div
              style={{
                position: "absolute", top: 0, left: 0, right: 0,
                height: "12%",
                background: "rgba(0,0,0,0.88)",
                zIndex: 13, pointerEvents: "none",
              }}
            />
            <div
              style={{
                position: "absolute", bottom: 0, left: 0, right: 0,
                height: "12%",
                background: "rgba(0,0,0,0.88)",
                zIndex: 13, pointerEvents: "none",
              }}
            />
          </>
        )}
      </div>

      {/* ── Playback controls row ── */}
      <div
        style={{
          background: "var(--bg-2)",
          borderTop: "1px solid var(--border)",
          padding: "0.4rem 0.65rem",
          display: "flex",
          alignItems: "center",
          gap: "0.45rem",
        }}
      >
        {/* Time display */}
        <span
          style={{
            fontSize: "0.65rem",
            color: "var(--text-3)",
            fontFamily: "monospace",
            flexShrink: 0,
            minWidth: 72,
          }}
        >
          {fmtT(currentTime)} / {fmtT(duration)}
        </span>

        {/* Play / pause */}
        <button
          onClick={togglePlay}
          style={{
            background: "none",
            border: "none",
            color: url ? "var(--text)" : "var(--text-3)",
            cursor: url ? "pointer" : "default",
            fontSize: "0.95rem",
            padding: "0 0.05rem",
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            lineHeight: 1,
          }}
        >
          {playing && url ? "⏸" : "▶"}
        </button>

        {/* Volume */}
        <button
          onClick={() => {
            if (videoRef.current) {
              videoRef.current.muted = !muted;
              setMuted((m) => !m);
            }
          }}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-2)",
            cursor: url ? "pointer" : "default",
            fontSize: "0.85rem",
            padding: "0 0.05rem",
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            lineHeight: 1,
          }}
        >
          {muted ? "🔇" : "🔊"}
        </button>

        {/* Dash separator */}
        <span style={{ color: "var(--border)", fontSize: "0.8rem", flexShrink: 0, lineHeight: 1 }}>—</span>

        {/* Scrubber track */}
        <div
          style={{
            flex: 1,
            position: "relative",
            height: 5,
            cursor: url ? "pointer" : "default",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "var(--bg-4)",
              borderRadius: 3,
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              height: "100%",
              width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
              background: "var(--cyan)",
              borderRadius: 3,
              transition: "width 0.05s linear",
            }}
          />
          {/* Thumb */}
          {duration > 0 && (
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: `${(currentTime / duration) * 100}%`,
                transform: "translate(-50%, -50%)",
                width: 11,
                height: 11,
                borderRadius: "50%",
                background: "var(--cyan)",
                boxShadow: "0 0 4px rgba(6,182,212,0.55)",
                pointerEvents: "none",
              }}
            />
          )}
          {url && (
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.01}
              value={currentTime}
              onChange={handleSeek}
              style={{
                position: "absolute",
                inset: 0,
                opacity: 0,
                cursor: "pointer",
                width: "100%",
              }}
            />
          )}
        </div>

        {/* + button */}
        <button
          style={{
            background: "none",
            border: "none",
            color: "var(--text-3)",
            fontSize: "1rem",
            padding: "0 0.05rem",
            cursor: "pointer",
            lineHeight: 1,
            flexShrink: 0,
          }}
          title="Adjust trim"
        >
          +
        </button>
      </div>
    </div>
  );
}

/* ── Timeline strip ─────────────────────────────────────── */

function TimelineStrip({
  segments,
  editedText,
  beats = [],
  trackName,
}: {
  segments: { start: number; end: number; text: string }[];
  editedText: string;
  beats?: number[];
  trackName?: string | null;
}) {
  const lastSeg  = segments[segments.length - 1]?.end || 0;
  const lastBeat = beats[beats.length - 1] || 0;
  const total    = Math.max(lastSeg, lastBeat, 14);

  const fmtTC = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  // How many ticks to show (aim for ~8–12 visible)
  const tickInterval = Math.max(1, Math.round(total / 10));
  const ticks = Array.from(
    { length: Math.floor(total / tickInterval) + 1 },
    (_, i) => i * tickInterval,
  );

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      {/* ── Timestamp ruler ── */}
      <div
        style={{
          position: "relative",
          height: 20,
          background: "var(--bg-3)",
          overflowX: "hidden",
        }}
      >
        {ticks.map((t) => {
          const left = (t / total) * 100;
          return (
            <div
              key={t}
              style={{
                position: "absolute",
                left: `${left}%`,
                top: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                transform: "translateX(-50%)",
              }}
            >
              <span
                style={{
                  fontSize: "0.46rem",
                  color: "var(--text-3)",
                  whiteSpace: "nowrap",
                  lineHeight: "12px",
                }}
              >
                {fmtTC(t)}
              </span>
              <div
                style={{
                  width: 1,
                  height: 6,
                  background: "var(--border)",
                  marginTop: 1,
                }}
              />
            </div>
          );
        })}
      </div>

      {/* ── Waveform / clip track ── */}
      <div
        style={{
          height: 38,
          background: "var(--bg-4)",
          position: "relative",
          overflow: "hidden",
          borderTop: "1px solid var(--border)",
        }}
      >
        {/* Colored segment blocks */}
        {segments.slice(0, 30).map((seg, i) => {
          const left  = (seg.start / total) * 100;
          const width = Math.max(((seg.end - seg.start) / total) * 100, 0.3);
          return (
            <div
              key={i}
              title={seg.text}
              style={{
                position: "absolute",
                left: `${left}%`,
                width: `${width}%`,
                height: "100%",
                background:
                  i % 2 === 0
                    ? "rgba(139,92,246,0.45)"
                    : "rgba(249,115,22,0.35)",
                borderRight: "1px solid rgba(0,0,0,0.18)",
              }}
            />
          );
        })}

        {/* Beat tick marks */}
        {beats.map((beat, i) => (
          <div
            key={`b${i}`}
            style={{
              position: "absolute",
              left: `${(beat / total) * 100}%`,
              top: 0,
              width: 1.5,
              height: "100%",
              background: "rgba(251,191,36,0.55)",
              pointerEvents: "none",
            }}
          />
        ))}

        {/* Beat count badge */}
        {beats.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: "0.2rem",
              right: "0.3rem",
              fontSize: "0.46rem",
              color: "rgba(251,191,36,0.8)",
              display: "flex",
              alignItems: "center",
              gap: "0.2rem",
              background: "rgba(0,0,0,0.4)",
              padding: "0.08rem 0.25rem",
              borderRadius: 3,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 5,
                height: 5,
                borderRadius: 1,
                background: "rgba(251,191,36,0.75)",
              }}
            />
            {beats.length} beats
          </div>
        )}
      </div>

      {/* ── Text track row ── */}
      <div
        style={{
          height: 30,
          background: "var(--bg-3)",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          padding: "0 0.65rem",
          gap: "0.4rem",
        }}
      >
        <button
          title="Loop"
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-3)",
            fontSize: "0.78rem",
            padding: 0,
            flexShrink: 0,
            lineHeight: 1,
          }}
        >
          ↻
        </button>
        <span
          style={{
            fontSize: "0.65rem",
            color: "var(--text-3)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
          }}
        >
          + Add Text{trackName ? ` (${trackName.toUpperCase()})` : ""}
          {!trackName && editedText ? ` (${editedText.slice(0, 28).toUpperCase()}…)` : ""}
        </span>
      </div>
    </div>
  );
}

/* ── Word-by-Word Timestamp Editor ─────────────────────── */

export interface WordEntry {
  id: string;
  text: string;
  start: number;
  end: number;
}

const MIN_DUR = 0.02;

function WordTimestampEditor({
  words,
  onChange,
}: {
  words: WordEntry[];
  onChange: (words: WordEntry[]) => void;
}) {
  const [focusId, setFocusId] = useState<string | null>(null);

  const update = useCallback(
    (id: string, patch: Partial<WordEntry>) => {
      onChange(words.map((w) => (w.id === id ? { ...w, ...patch } : w)));
    },
    [words, onChange],
  );

  const remove = useCallback(
    (id: string) => {
      onChange(words.filter((w) => w.id !== id));
    },
    [words, onChange],
  );

  const insertAfter = useCallback(
    (afterId: string | null) => {
      const idx =
        afterId === null ? -1 : words.findIndex((w) => w.id === afterId);
      const prev = idx >= 0 ? words[idx] : null;
      const next = words[idx + 1] ?? null;
      const start = prev ? prev.end : 0;
      const end = next
        ? Math.max(start + 0.2, (start + next.start) / 2)
        : start + 0.5;
      const newW: WordEntry = { id: `w_${Date.now()}`, text: "", start, end };
      const copy = [...words];
      copy.splice(idx + 1, 0, newW);
      onChange(copy);
      setFocusId(newW.id);
    },
    [words, onChange],
  );

  if (words.length === 0) {
    return (
      <p className="text-sm text-3" style={{ padding: "0.5rem 0" }}>
        Brak słów. Kliknij ↻ Refresh żeby transkrybować.
      </p>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.4rem",
        alignItems: "center",
      }}
    >
      <InsertBtn onClick={() => insertAfter(null)} />

      {words.map((w) => {
        const dur = w.end - w.start;
        const hasErr = dur < MIN_DUR;
        const isFocused = focusId === w.id;

        return (
          <React.Fragment key={w.id}>
            <WordCard
              word={w}
              hasErr={hasErr}
              isFocused={isFocused}
              autoFocusText={focusId === w.id && w.text === ""}
              onFocus={() => setFocusId(w.id)}
              onBlur={() => setFocusId(null)}
              onUpdate={(patch) => update(w.id, patch)}
              onRemove={() => remove(w.id)}
            />
            <InsertBtn onClick={() => insertAfter(w.id)} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

function WordCard({
  word,
  hasErr,
  isFocused,
  autoFocusText,
  onFocus,
  onBlur,
  onUpdate,
  onRemove,
}: {
  word: WordEntry;
  hasErr: boolean;
  isFocused: boolean;
  autoFocusText: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onUpdate: (patch: Partial<WordEntry>) => void;
  onRemove: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const borderColor = hasErr
    ? "rgba(239,68,68,0.7)"
    : isFocused
      ? "var(--cyan)"
      : hovered
        ? "rgba(255,255,255,0.2)"
        : "var(--border)";

  const bg = hasErr
    ? "rgba(239,68,68,0.07)"
    : isFocused
      ? "rgba(6,182,212,0.07)"
      : "var(--bg-3)";

  return (
    <div
      onFocus={onFocus}
      onBlur={onBlur}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "0.3rem",
        padding: "0.55rem 0.65rem 0.45rem",
        background: bg,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 10,
        minWidth: 76,
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      {/* Delete — appears on hover */}
      {hovered && (
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            onRemove();
          }}
          title="Usuń"
          style={{
            position: "absolute",
            top: -7,
            right: -7,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "var(--red)",
            border: "none",
            color: "#fff",
            fontSize: "0.6rem",
            fontWeight: 700,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
            zIndex: 2,
          }}
        >
          ×
        </button>
      )}

      {/* Word text — hero element */}
      <input
        type="text"
        value={word.text}
        autoFocus={autoFocusText}
        onChange={(e) => onUpdate({ text: e.target.value })}
        placeholder="słowo"
        style={{
          fontSize: "0.9rem",
          fontWeight: 700,
          textAlign: "center",
          background: "transparent",
          border: "none",
          outline: "none",
          color: hasErr ? "var(--red)" : "var(--text-1)",
          width: "100%",
          minWidth: 60,
          padding: 0,
        }}
      />

      {/* Timestamps — secondary */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.2rem" }}>
        <input
          type="number"
          value={word.start}
          step={0.01}
          min={0}
          onChange={(e) => onUpdate({ start: parseFloat(e.target.value) || 0 })}
          style={{
            width: 38,
            fontSize: "0.62rem",
            fontFamily: "monospace",
            background: "var(--bg-4)",
            border: `1px solid ${hasErr ? "rgba(239,68,68,0.4)" : "var(--border)"}`,
            borderRadius: 4,
            padding: "0.1rem 0.2rem",
            color: hasErr ? "var(--red)" : "var(--cyan)",
            textAlign: "center",
            outline: "none",
          }}
        />
        <span
          style={{
            fontSize: "0.6rem",
            color: "var(--text-3)",
            userSelect: "none",
          }}
        >
          →
        </span>
        <input
          type="number"
          value={word.end}
          step={0.01}
          min={0}
          onChange={(e) => onUpdate({ end: parseFloat(e.target.value) || 0 })}
          style={{
            width: 38,
            fontSize: "0.62rem",
            fontFamily: "monospace",
            background: "var(--bg-4)",
            border: `1px solid ${hasErr ? "rgba(239,68,68,0.4)" : "var(--border)"}`,
            borderRadius: 4,
            padding: "0.1rem 0.2rem",
            color: hasErr ? "var(--red)" : "var(--cyan)",
            textAlign: "center",
            outline: "none",
          }}
        />
      </div>

      {/* Error hint */}
      {hasErr && (
        <span
          style={{
            fontSize: "0.55rem",
            color: "var(--red)",
            whiteSpace: "nowrap",
            lineHeight: 1,
          }}
        >
          min {MIN_DUR}s
        </span>
      )}
    </div>
  );
}

function InsertBtn({ onClick }: { onClick: () => void }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      title="Wstaw słowo"
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: 20,
        height: 20,
        borderRadius: "50%",
        flexShrink: 0,
        border: `1.5px ${hov ? "solid" : "dashed"} ${hov ? "var(--cyan)" : "var(--border)"}`,
        background: hov ? "rgba(6,182,212,0.12)" : "transparent",
        cursor: "pointer",
        fontSize: "0.75rem",
        fontWeight: 700,
        color: hov ? "var(--cyan)" : "var(--text-3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "all 0.15s",
      }}
    >
      +
    </button>
  );
}

/* ── Batch status ───────────────────────────────────────── */

function BatchStatus({
  job,
  onReset,
}: {
  job: JobMetadata;
  onReset: () => void;
}) {
  const col = (s: string) =>
    s === "done" ? "var(--green)" : s === "error" ? "var(--red)" : "var(--orange)";

  const isActive = job.status === "queued" || job.status === "processing";
  const pct = job.progress ?? (job.status === "processing" ? 15 : job.status === "queued" ? 3 : 100);
  const stepLabel = job.step ?? (job.status === "queued" ? "Czekam na worker…" : job.status === "processing" ? "Przetwarzam…" : "");

  // Elapsed time
  const [elapsed, setElapsed] = React.useState(Math.floor((Date.now() - job.created_at) / 1000));
  React.useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - job.created_at) / 1000)), 1000);
    return () => clearInterval(t);
  }, [isActive, job.created_at]);
  const fmtElapsed = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;

  return (
    <div className="card card-p">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <p style={{ fontWeight: 700, fontSize: "0.85rem" }}>Render job</p>
        <span className="badge" style={{ background: `${col(job.status)}18`, color: col(job.status) }}>
          {job.status === "done" ? "✅ gotowe" : job.status === "error" ? "❌ błąd" : "⏳ renderuję"}
        </span>
      </div>

      {/* Progress loader */}
      {isActive && (
        <div style={{ marginBottom: "0.75rem" }}>
          {/* Bar */}
          <div style={{ position: "relative", height: 8, background: "var(--bg-4)", borderRadius: 99, overflow: "hidden", marginBottom: "0.55rem" }}>
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                height: "100%",
                width: `${pct}%`,
                background: "linear-gradient(90deg, var(--purple), var(--cyan))",
                borderRadius: 99,
                transition: "width 0.6s ease",
              }}
            />
            {/* Shimmer */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                height: "100%",
                width: "100%",
                background: "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.12) 50%, transparent 100%)",
                animation: "shimmer 1.8s infinite",
              }}
            />
          </div>

          {/* Step label + pct + elapsed */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--text-2)" }}>
              {stepLabel}
              {job.total_variants && job.total_variants > 1 && job.done_variants != null && (
                <span style={{ color: "var(--text-3)", marginLeft: "0.4rem" }}>
                  ({job.done_variants}/{job.total_variants} wariantów)
                </span>
              )}
            </span>
            <div style={{ display: "flex", gap: "0.65rem", alignItems: "center" }}>
              <span style={{ fontSize: "0.72rem", color: "var(--text-3)" }}>⏱ {fmtElapsed(elapsed)}</span>
              <span style={{ fontSize: "0.72rem", color: "var(--purple)", fontWeight: 700 }}>{pct}%</span>
            </div>
          </div>

          {/* Phase dots */}
          {(() => {
            const skipTranscription = (job.phases_skipped ?? []).includes("transcription");
            const phases = [
              { key: "beat", label: "Analiza beatów", from: 0, to: skipTranscription ? 20 : 12 },
              ...(!skipTranscription ? [{ key: "transcription", label: "Transkrypcja", from: 12, to: 30 }] : []),
              { key: "render", label: "Montaż wideo", from: skipTranscription ? 20 : 30, to: 97 },
              { key: "done", label: "Gotowe", from: 97, to: 100 },
            ];
            return (
              <div style={{ display: "flex", gap: "0.35rem", marginTop: "0.6rem", flexWrap: "wrap" }}>
                {phases.map((phase) => {
                  const done = pct >= phase.to;
                  const active = pct >= phase.from && pct < phase.to;
                  return (
                    <span key={phase.key} style={{
                      fontSize: "0.65rem",
                      padding: "0.15rem 0.5rem",
                      borderRadius: 99,
                      background: done ? "rgba(34,197,94,.15)" : active ? "rgba(139,92,246,.2)" : "var(--bg-4)",
                      color: done ? "var(--green)" : active ? "var(--purple)" : "var(--text-3)",
                      border: `1px solid ${done ? "rgba(34,197,94,.3)" : active ? "rgba(139,92,246,.4)" : "transparent"}`,
                      fontWeight: active ? 700 : 400,
                      transition: "all 0.3s",
                    }}>
                      {done ? "✓ " : active ? "● " : "○ "}{phase.label}
                    </span>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {job.status === "error" && (
        <p style={{ color: "var(--red)", fontSize: "0.8rem", marginBottom: "0.6rem" }}>
          {job.error ?? "Nieznany błąd."}
        </p>
      )}

      {job.status === "done" && job.outputs && job.outputs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginBottom: "0.5rem" }}>
          {job.outputs.map((o: JobOutput, i: number) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.6rem",
                padding: "0.5rem 0.65rem",
                background: "var(--bg-3)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
              }}
            >
              <span className="badge badge-green" style={{ fontSize: "0.6rem" }}>v{o.variant}</span>
              <span className="text-xs truncate" style={{ flex: 1 }}>{o.platform ?? o.style}</span>
              <a href={absoluteUrl(o.video_url)} download className="btn btn-sm btn-primary" style={{ padding: "0.3rem 0.6rem", fontSize: "0.72rem" }}>
                ⬇ MP4
              </a>
              {(o.caption_url || o.srt_url) && (
                <a href={absoluteUrl((o.caption_url || o.srt_url)!)} download className="btn btn-sm btn-ghost" style={{ padding: "0.3rem 0.6rem", fontSize: "0.72rem" }}>
                  Napisy
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      <button className="btn btn-ghost btn-sm" onClick={onReset} style={{ marginTop: "0.4rem" }}>
        ← Nowy render
      </button>
    </div>
  );
}
