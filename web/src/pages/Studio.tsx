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
  TranscriptionSegment,
} from "../context/AppContext";
import type {
  Composition,
  CompositionLayer,
  CustomTextConfig,
} from "../lib/api";
import {
  uploadMusic,
  transcribeTrack,
  updateTranscription,
  generatePreview,
  generateBatch,
  watchJob,
  absoluteUrl,
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

// ── Caption animation options ─────────────────────────────
const CAPTION_ANIMATIONS: { id: string; label: string; icon: string }[] = [
  { id: "none",   label: "None",   icon: "—"  },
  { id: "pop",    label: "Pop",    icon: "✦"  },
  { id: "bounce", label: "Bounce", icon: "〜" },
  { id: "fade",   label: "Fade",   icon: "◌"  },
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

let _uid = 1;
const uid = () => `layer_${Date.now()}_${_uid++}`;
const compId = () => `comp_${Date.now()}_${_uid++}`;

/** Slug jak w backendzie (folder w /exports). */
function packSlugPreview(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  return s.replace(/-+/g, "-").replace(/^-|-$/g, "") || "";
}

function defaultComposition(audioId: string): Composition {
  return {
    id: compId(),
    audioId,
    aspectRatio: "9:16",
    resizeMode: "cover",
    outputDisplayMode: "full",
    layers: [
      { id: uid(), type: "video_base", start: 0, end: 9999, zIndex: 0, config: {} },
    ],
  };
}
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
    hooks,
    studioPackName,
    setStudioPackName,
    studioTrackId,
    studioCollectionId,
    studioHookId,
    studioHookFolderId,
    studioPresetId,
    studioLyricStyle,
    studioLyricColor,
    studioLyricActiveColor,
    studioCaptionDisplayMode,
    studioCaptionPosition,
    studioMoodId,
    studioComposition,
    setStudioComposition,
    setStudioTrack,
    setStudioCollection,
    setStudioHook,
    setStudioHookFolder,
    setStudioPreset,
    setStudioLyricStyle,
    setStudioLyricColor,
    setStudioLyricActiveColor,
    setStudioCaptionDisplayMode,
    setStudioCaptionPosition,
    setStudioMood: _setStudioMood,
    transcriptions,
    setTranscription,
    addTrack,
  } = useApp();

  // Local mood filter for the collection grid in Studio
  const [colMoodFilter, setColMoodFilter] = useState<string>("all");

  const track = tracks.find((t) => t.id === studioTrackId) ?? null;
  const collection =
    collections.find((c) => c.id === studioCollectionId) ?? null;

  // Ensure composition exists when a track is selected
  useEffect(() => {
    if (track && (!studioComposition || studioComposition.audioId !== track.id)) {
      setStudioComposition(defaultComposition(track.id));
    }
    if (!track) setStudioComposition(null);
  }, [track?.id]);

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

  // Sync textarea → word grid: when user edits "Edycja tekstu", update "Czasy słowo po słowie"
  useEffect(() => {
    if (!isWordMode || !(currentSegments ?? wordEntries.length)) return;
    const newWords = editedText
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (newWords.length === 0) {
      setWordEntries([]);
      return;
    }
    const base: WordEntry[] =
      wordEntries.length > 0
        ? wordEntries
        : (currentSegments ?? []).map((s, i) => ({
            id: `w${i}_${s.start}`,
            text: s.text,
            start: s.start,
            end: s.end,
          }));
    const N = base.length;
    const M = newWords.length;
    if (M === N) {
      setWordEntries(base.map((e, i) => ({ ...e, text: newWords[i] ?? e.text })));
    } else if (M > N) {
      const lastEnd = N > 0 ? base[N - 1].end : 0;
      const newEntries = base.map((e, i) => ({ ...e, text: newWords[i] ?? e.text }));
      let t = lastEnd;
      for (let i = N; i < M; i++) {
        newEntries.push({
          id: `w_${Date.now()}_${i}`,
          text: newWords[i] ?? "",
          start: t,
          end: t + 0.2,
        });
        t += 0.2;
      }
      setWordEntries(newEntries);
    } else {
      const lastEnd = base[N - 1].end;
      setWordEntries(
        base.slice(0, M).map((e, i) => ({
          ...e,
          text: newWords[i] ?? e.text,
          end: i === M - 1 ? lastEnd : e.end,
        })),
      );
    }
  }, [editedText]);

  // Zapis przy każdej zmianie: edycja tekstu / słów → cache w kontekście + debounced zapis na backend (żeby edycja przetrwała odświeżenie)
  const saveTranscriptionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!studioTrackId || !isWordMode) return;
    const segments: TranscriptionSegment[] = wordEntries.map(({ text, start, end }) => ({
      text,
      start,
      end,
      word: true,
    }));
    const same =
      currentSegments?.length === segments.length &&
      currentSegments.every(
        (s, i) =>
          s.text === segments[i].text &&
          s.start === segments[i].start &&
          s.end === segments[i].end
      );
    if (!same) {
      setTranscription(studioTrackId, segments);
      if (saveTranscriptionDebounceRef.current) clearTimeout(saveTranscriptionDebounceRef.current);
      saveTranscriptionDebounceRef.current = setTimeout(() => {
        saveTranscriptionDebounceRef.current = null;
        const payload = segments.map(({ text, start, end }) => ({ text, start, end }));
        updateTranscription(studioTrackId, payload, segments.map((s) => s.text).join(" ")).catch(() => {});
      }, 1500);
    }
    return () => {
      if (saveTranscriptionDebounceRef.current) clearTimeout(saveTranscriptionDebounceRef.current);
    };
  }, [wordEntries, studioTrackId, isWordMode, setTranscription, currentSegments]);

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
  const [batchEditCount, setBatchEditCount] = useState<number>(1);
  const [studioFont, setStudioFont] = useState<string>("arial");
  const [studioCapAnim, setStudioCapAnim] = useState<string>("none");
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
        pack_name: studioPackName.trim() || undefined,
        platforms: selectedPlatforms,
        preset_id: studioPresetId ?? undefined,
        caption_color: studioLyricColor,
        caption_active_color: studioLyricActiveColor,
        caption_font: studioFont !== "arial" ? studioFont : undefined,
        caption_animation: studioCapAnim !== "none" ? studioCapAnim : undefined,
        caption_display_mode: studioCaptionDisplayMode,
        caption_position: studioCaptionPosition,
        mood_id: studioMoodId ?? collection?.folderId ?? undefined,
        duration_mode: "auto",
        batch_count: Math.min(100, Math.max(1, batchEditCount)),
        segments: segsToSend,
        seed: !isNaN(parsedSeed!) ? parsedSeed : undefined,
        hook_id: studioHookFolderId ? undefined : (studioHookId ?? undefined),
        hook_folder_id: studioHookFolderId ?? undefined,
        composition: studioComposition ?? undefined,
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
            padding: "1.5rem 1.75rem",
            display: "flex",
            flexDirection: "column",
            gap: 0,
            borderRight: "1px solid var(--border)",
            background: "var(--bg-1)",
          }}
        >
          {/* ── 0. Nazwa paczki mixów ── */}
          <Section
            title="Nazwa paczki mixów"
            step={0}
            description="Nazwa tej serii (np. „moje hype mixy edycja 5”). Eksporty trafią do folderu /exports/nazwa-paczki — w zakładce Eksporty i na dysku możesz je segregować po paczce."
          >
            <input
              type="text"
              value={studioPackName}
              onChange={(e) => setStudioPackName(e.target.value)}
              placeholder="np. moje hype mixy edycja 5"
              style={{
                width: "100%",
                padding: "0.55rem 0.75rem",
                borderRadius: 10,
                border: "1.5px solid var(--border)",
                background: "var(--bg-3)",
                color: "var(--text)",
                fontSize: "0.9rem",
              }}
            />
            {studioPackName.trim() && (
              <p style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: "0.35rem" }}>
                Folder eksportów: <code style={{ background: "var(--bg-3)", padding: "0.1rem 0.3rem", borderRadius: 4 }}>/exports/{packSlugPreview(studioPackName) || "…"}</code>
              </p>
            )}
          </Section>

          {/* ── 1. Plik audio ── */}
          <Section
            title="Plik audio"
            step={1}
            description="Wybierz utwór z biblioteki lub wgraj plik (MP3, WAV, AAC, FLAC). Na jego podstawie zrobimy wideo z cięciami na bit i napisami."
          >
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
                  Zmień plik
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
            <section
              style={{
                padding: "1.35rem 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              {/* Header row — always visible */}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "0.75rem",
                  marginBottom: "0.5rem",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      background: "linear-gradient(135deg, rgba(139,92,246,0.2) 0%, rgba(139,92,246,0.08) 100%)",
                      border: "1px solid rgba(139,92,246,0.4)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "0.75rem",
                      fontWeight: 800,
                      color: "#c4b5fd",
                      flexShrink: 0,
                    }}
                  >
                    2
                  </div>
                  <div>
                    <h3 style={{ fontWeight: 700, fontSize: "0.95rem", margin: 0 }}>Transkrypcja</h3>
                    <span style={{ fontSize: "0.65rem", color: "var(--text-3)", fontWeight: 600 }}>Sprawdź i edytuj tekst</span>
                  </div>
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
                      Zapisano
                    </span>
                  )}
                  {currentSegments && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setLyricsOpen((v) => !v)}
                    >
                      {lyricsOpen ? "Zwiń" : "Edytuj"}
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

              <p
                style={{
                  marginTop: "0.4rem",
                  marginBottom: "0.9rem",
                  lineHeight: 1.5,
                  maxWidth: "42rem",
                  fontSize: "0.8rem",
                  color: "var(--text-3)",
                }}
              >
                Whisper tworzy tekst i timestampy do napisów. Sprawdź transkrypcję i w razie potrzeby edytuj słowo po słowie — wideo użyje Twoich czasów.
              </p>

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
                    Edycja tekstu
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
                    style={{ marginBottom: "0.85rem", fontSize: "0.8rem", color: "var(--text-3)" }}
                  >
                    Zmiany tutaj synchronizują się z widokiem czasów poniżej.
                  </p>

                  {/* Word-by-Word grid */}
                  <p
                    style={{
                      fontWeight: 700,
                      fontSize: "0.85rem",
                      marginBottom: "0.6rem",
                    }}
                  >
                    Czasy słowo po słowie
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
            </section>
          )}

          {/* ── 3. Format wideo (move before collection so order is: audio, transcribe, format, hooki, lyrics, preset, collection) ── */}
          {studioComposition && (
            <Section
              title="Format wideo"
              step={3}
              description="Pełny ekran (TikTok, Reels) albo kwadrat na środku z czarnymi paskami. Poniżej proporcje i warstwy."
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
                {/* Układ na ekranie */}
                <div>
                  <p className="label" style={{ marginBottom: "0.5rem" }}>Układ na ekranie</p>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-3)", marginBottom: "0.5rem", lineHeight: 1.4 }}>
                    Wideo może zająć cały ekran albo być kwadratem z czarnymi paskami.
                  </p>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {(
                      [
                        { id: "full" as const, label: "Pełny ekran", sub: "Cały ekran (TikTok, Reels)" },
                        { id: "1:1_letterbox" as const, label: "Kwadrat na środku", sub: "Kwadrat, czarne paski u góry i na dole" },
                      ] as const
                    ).map(({ id, label, sub }) => {
                      const active = (studioComposition.outputDisplayMode ?? "full") === id;
                      return (
                        <button
                          key={id}
                          onClick={() => setStudioComposition({ ...studioComposition, outputDisplayMode: id })}
                          style={{
                            padding: "0.6rem 0.9rem",
                            borderRadius: 10,
                            border: `2px solid ${active ? "var(--purple)" : "var(--border)"}`,
                            background: active ? "var(--purple-dim)" : "var(--bg-3)",
                            cursor: "pointer",
                            fontSize: "0.85rem",
                            fontWeight: 600,
                            color: active ? "#c4b5fd" : "var(--text)",
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-start",
                            gap: "0.15rem",
                            textAlign: "left",
                            minWidth: "140px",
                            transition: "all 0.15s ease",
                          }}
                        >
                          <span>{label}</span>
                          <span style={{ fontSize: "0.65rem", color: "var(--text-3)", fontWeight: 400 }}>{sub}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {(studioComposition.outputDisplayMode ?? "full") === "full" ? (
                  <>
                    <div>
                      <p className="label" style={{ marginBottom: "0.5rem" }}>Proporcje wideo</p>
                      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                        {(
                          [
                            { id: "9:16" as const, label: "Pion 9:16", sub: "TikTok, Reels" },
                            { id: "1:1" as const, label: "Kwadrat 1:1", sub: "Instagram" },
                            { id: "4:5" as const, label: "4:5", sub: "Feed" },
                            { id: "16:9" as const, label: "Poziomo 16:9", sub: "YouTube" },
                          ] as const
                        ).map(({ id, label, sub }) => (
                          <button
                            key={id}
                            onClick={() => setStudioComposition({ ...studioComposition, aspectRatio: id })}
                            style={{
                              padding: "0.45rem 0.7rem",
                              borderRadius: 10,
                              border: `1.5px solid ${studioComposition.aspectRatio === id ? "var(--purple)" : "var(--border)"}`,
                              background: studioComposition.aspectRatio === id ? "var(--purple-dim)" : "var(--bg-3)",
                              cursor: "pointer",
                              fontSize: "0.8rem",
                              fontWeight: 600,
                              color: studioComposition.aspectRatio === id ? "#c4b5fd" : "var(--text)",
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              gap: "0.1rem",
                              transition: "all 0.15s ease",
                            }}
                          >
                            <span>{label}</span>
                            <span style={{ fontSize: "0.6rem", color: "var(--text-3)", fontWeight: 400 }}>{sub}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="label" style={{ marginBottom: "0.5rem" }}>Dopasowanie klipu</p>
                      <div style={{ display: "flex", gap: "0.4rem" }}>
                        {(
                          [{ mode: "cover" as const, label: "Wypełnij kadr", sub: "Przycięcie" },
                           { mode: "contain" as const, label: "Pokaż całość", sub: "Paski" }] as const
                        ).map(({ mode, label, sub }) => (
                          <button
                            key={mode}
                            onClick={() => setStudioComposition({ ...studioComposition, resizeMode: mode })}
                            style={{
                              padding: "0.45rem 0.7rem",
                              borderRadius: 10,
                              border: `1.5px solid ${studioComposition.resizeMode === mode ? "var(--purple)" : "var(--border)"}`,
                              background: studioComposition.resizeMode === mode ? "var(--purple-dim)" : "var(--bg-3)",
                              cursor: "pointer",
                              fontSize: "0.8rem",
                              fontWeight: 600,
                              color: studioComposition.resizeMode === mode ? "#c4b5fd" : "var(--text)",
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "flex-start",
                              gap: "0.1rem",
                              textAlign: "left",
                              transition: "all 0.15s ease",
                            }}
                          >
                            <span>{label}</span>
                            <span style={{ fontSize: "0.6rem", color: "var(--text-3)", fontWeight: 400 }}>{sub}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <p style={{ fontSize: "0.78rem", color: "var(--text-3)", lineHeight: 1.4 }}>
                    W trybie „Kwadrat na środku” wideo ma proporcje 1:1, plik wyjściowy 9:16 z czarnymi paskami.
                  </p>
                )}
                <div>
                  <p className="label" style={{ marginBottom: "0.5rem" }}>Warstwy</p>
                  <p style={{ fontSize: "0.75rem", color: "var(--text-3)", marginBottom: "0.5rem" }}>Tekst, napisy — kolejność od dołu do góry</p>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.4rem" }}>
                    <span />
                    <AddTextButton
                      composition={studioComposition}
                      onAdd={(layer) => {
                        const next = [...studioComposition.layers, layer].sort((a, b) => a.zIndex - b.zIndex);
                        setStudioComposition({ ...studioComposition, layers: next });
                      }}
                    />
                  </div>
                  <LayersList
                    layers={studioComposition.layers}
                    onReorder={(layers) => setStudioComposition({ ...studioComposition, layers })}
                    onRemove={(id) =>
                      setStudioComposition({
                        ...studioComposition,
                        layers: studioComposition.layers.filter((l) => l.id !== id),
                      })
                    }
                  />
                </div>
              </div>
            </Section>
          )}

          {/* ── 4. Tekst hooka ── */}
          <Section
            title="Tekst hooka (POV / CTA)"
            step={4}
            description="Warstwy działają tak: (1) Hook — u góry albo brak; (2) Tekst piosenki — w ilości i na pozycji wybranej poniżej. Tu ustawiasz hook: jeden konkretny, folder (losowo), albo bez hooka. Hook zawsze wyświetla się u góry kadru."
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div>
                <p className="label" style={{ marginBottom: "0.5rem" }}>Tryb</p>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  {[
                    { id: "none", label: "Bez hooka" },
                    { id: "single", label: "Jeden hook" },
                    { id: "folder", label: "Folder (losowo)" },
                  ].map(({ id, label }) => {
                    const mode = studioHookFolderId ? "folder" : (studioHookId ? "single" : "none");
                    const active = mode === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          if (id === "none") {
                            setStudioHook(null);
                            setStudioHookFolder(null);
                          } else if (id === "single") {
                            setStudioHookFolder(null);
                            // Żeby tryb "Jeden hook" był aktywny, musi być wybrany hook — jeśli brak, ustaw pierwszy z puli
                            if (!studioHookId && hooks.length > 0) {
                              setStudioHook(hooks[0].id);
                            }
                          } else {
                            setStudioHook(null);
                            setStudioHookFolder(moods.find((m) => hooks.some((h) => h.category === m.id))?.id ?? moods[0]?.id ?? null);
                          }
                        }}
                        style={{
                          padding: "0.45rem 0.75rem",
                          borderRadius: 10,
                          border: `1.5px solid ${active ? "var(--purple)" : "var(--border)"}`,
                          background: active ? "var(--purple-dim)" : "var(--bg-3)",
                          cursor: "pointer",
                          fontSize: "0.82rem",
                          fontWeight: 600,
                          color: active ? "#c4b5fd" : "var(--text)",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {(!studioHookFolderId && studioHookId) || (!studioHookFolderId && !studioHookId) ? (
                <div>
                  <p className="label" style={{ marginBottom: "0.5rem" }}>Hook z puli</p>
                  <select
                    value={studioHookId ?? ""}
                    onChange={(e) => setStudioHook(e.target.value || null)}
                    style={{
                      width: "100%",
                      padding: "0.55rem 0.75rem",
                      borderRadius: 10,
                      border: "1.5px solid var(--border)",
                      background: "var(--bg-3)",
                      color: "var(--text)",
                      fontSize: "0.9rem",
                      cursor: "pointer",
                    }}
                  >
                    <option value="">— wybierz hook —</option>
                    {hooks.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.text} {h.category ? `(${moods.find((m) => m.id === h.category)?.label ?? h.category})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {studioHookFolderId ? (
                <div>
                  <p className="label" style={{ marginBottom: "0.5rem" }}>Folder (mood) — losowy hook na każdy wariant</p>
                  <select
                    value={studioHookFolderId}
                    onChange={(e) => setStudioHookFolder(e.target.value || null)}
                    style={{
                      width: "100%",
                      padding: "0.55rem 0.75rem",
                      borderRadius: 10,
                      border: "1.5px solid var(--border)",
                      background: "var(--bg-3)",
                      color: "var(--text)",
                      fontSize: "0.9rem",
                      cursor: "pointer",
                    }}
                  >
                    {moods.map((m) => {
                      const count = hooks.filter((h) => h.category === m.id).length;
                      return (
                        <option key={m.id} value={m.id}>
                          {m.emoji} {m.label} ({count} hooków)
                        </option>
                      );
                    })}
                  </select>
                  <p style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: "0.4rem" }}>
                    Przy generowaniu każdy wariant dostanie losowy hook z tego folderu.
                  </p>
                </div>
              ) : null}
              {hooks.length === 0 && (
                <p style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
                  Zakładka 🪝 Text Hooks → dodaj hooki i przypisz do moodów (folderów).
                </p>
              )}
            </div>
          </Section>

          {/* ── 5. Styl napisów (tekst piosenki) ── */}
          <Section
            title="Tekst piosenki (napisów)"
            step={5}
            description="To druga warstwa: tekst piosenki (słowa) wyświetlany w ilości i na pozycji, którą wybierzesz poniżej. Styl (BRAT, Bold…), kolor, karaoke, font i animacja."
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div>
                <p className="label" style={{ marginBottom: "0.5rem" }}>Styl</p>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  {LYRIC_STYLES.map((s) => {
                    const active = studioLyricStyle === s.id;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setStudioLyricStyle(s.id)}
                        style={{
                          padding: "0.45rem 0.75rem",
                          borderRadius: 10,
                          border: `1.5px solid ${active ? "var(--purple)" : "var(--border)"}`,
                          background: active ? "var(--purple-dim)" : "var(--bg-3)",
                          cursor: "pointer",
                          fontSize: "0.82rem",
                          fontWeight: 600,
                          color: active ? "#c4b5fd" : "var(--text)",
                          transition: "all 0.15s ease",
                        }}
                      >
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="label" style={{ marginBottom: "0.5rem" }}>Ilość tekstu</p>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  {(
                    [
                      { id: "1_word" as const, label: "1 słowo" },
                      { id: "2_words" as const, label: "2 słowa" },
                      { id: "3_words" as const, label: "3 słowa" },
                      { id: "1_line" as const, label: "1 linia" },
                      { id: "2_lines" as const, label: "2 linie" },
                      { id: "3_lines" as const, label: "3 linie" },
                    ] as const
                  ).map(({ id, label }) => {
                    const active = studioCaptionDisplayMode === id;
                    return (
                      <button
                        key={id}
                        onClick={() => setStudioCaptionDisplayMode(id)}
                        style={{
                          padding: "0.45rem 0.75rem",
                          borderRadius: 10,
                          border: `1.5px solid ${active ? "var(--purple)" : "var(--border)"}`,
                          background: active ? "var(--purple-dim)" : "var(--bg-3)",
                          cursor: "pointer",
                          fontSize: "0.82rem",
                          fontWeight: 600,
                          color: active ? "#c4b5fd" : "var(--text)",
                          transition: "all 0.15s ease",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="label" style={{ marginBottom: "0.5rem" }}>Pozycja napisów</p>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  {(
                    [
                      { id: "center" as const, label: "Na środku" },
                      { id: "bottom" as const, label: "Na dole" },
                    ] as const
                  ).map(({ id, label }) => {
                    const active = studioCaptionPosition === id;
                    return (
                      <button
                        key={id}
                        onClick={() => setStudioCaptionPosition(id)}
                        style={{
                          padding: "0.45rem 0.75rem",
                          borderRadius: 10,
                          border: `1.5px solid ${active ? "var(--purple)" : "var(--border)"}`,
                          background: active ? "var(--purple-dim)" : "var(--bg-3)",
                          cursor: "pointer",
                          fontSize: "0.82rem",
                          fontWeight: 600,
                          color: active ? "#c4b5fd" : "var(--text)",
                          transition: "all 0.15s ease",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <p style={{ fontSize: "0.7rem", color: "var(--text-3)", marginTop: "0.35rem" }}>
                  Pozycja tekstu piosenki: na środku lub na dole kadru (pod hookiem, jeśli jest). Ilość tekstu powyżej określa, ile słów/linii pokazujemy naraz.
                </p>
              </div>
              <div>
                <p className="label" style={{ marginBottom: "0.5rem" }}>Kolor napisów</p>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  {["#FFFFFF", "#FFFF00", "#FF9500", "#FF3B30", "#FF2D55", "#AF52DE", "#5856D6", "#007AFF", "#34C759", "#000000"].map((c) => (
                    <button
                      key={c}
                      onClick={() => setStudioLyricColor(c)}
                      title={c}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: c,
                        border: studioLyricColor === c ? "2.5px solid var(--purple)" : "1.5px solid var(--border)",
                        boxShadow: studioLyricColor === c ? "0 0 0 2px var(--purple-dim)" : "none",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                      }}
                    />
                  ))}
                  <input
                    type="color"
                    value={studioLyricColor}
                    onChange={(e) => setStudioLyricColor(e.target.value)}
                    style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid var(--border)", cursor: "pointer", padding: 0 }}
                  />
                </div>
              </div>
              <div>
                <p className="label" style={{ marginBottom: "0.5rem" }}>Kolor podświetlenia (karaoke)</p>
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
                        border: studioLyricActiveColor === c ? "2.5px solid var(--purple)" : "1.5px solid var(--border)",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                      }}
                    />
                  ))}
                  <input
                    type="color"
                    value={studioLyricActiveColor}
                    onChange={(e) => setStudioLyricActiveColor(e.target.value)}
                    style={{ width: 26, height: 26, borderRadius: 8, border: "none", cursor: "pointer", padding: 0 }}
                  />
                </div>
              </div>
              <div>
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
                          borderRadius: 10,
                          border: `1.5px solid ${active ? "var(--purple)" : "var(--border)"}`,
                          background: active ? "var(--purple-dim)" : "var(--bg-3)",
                          cursor: "pointer",
                          fontFamily: f.cssFont,
                          fontWeight: 700,
                          fontSize: "0.85rem",
                          color: active ? "#c4b5fd" : "var(--text)",
                          transition: "all 0.15s ease",
                        }}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="label" style={{ marginBottom: "0.5rem" }}>Animacja</p>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  {CAPTION_ANIMATIONS.map((a) => {
                    const active = studioCapAnim === a.id;
                    return (
                      <button
                        key={a.id}
                        onClick={() => setStudioCapAnim(a.id)}
                        style={{
                          padding: "0.45rem 0.9rem",
                          borderRadius: 10,
                          border: `1.5px solid ${active ? "var(--purple)" : "var(--border)"}`,
                          background: active ? "var(--purple-dim)" : "var(--bg-3)",
                          cursor: "pointer",
                          fontSize: "0.82rem",
                          fontWeight: 600,
                          color: active ? "#c4b5fd" : "var(--text)",
                          display: "flex",
                          alignItems: "center",
                          gap: "0.3rem",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <span style={{ opacity: 0.8 }}>{a.icon}</span>
                        {a.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </Section>

          {/* ── 6. Preset ── */}
          <Section
            title="Preset wideo"
            step={6}
            badge="Opcjonalnie"
            description="Styl montażu: cięcia na bit, przejścia, kolory, maks. długość. Wybierz szablon lub None i dostosuj napisy powyżej."
          >
            {presets.length === 0 ? (
              <p style={{ fontSize: "0.85rem", color: "var(--text-3)" }}>Ładowanie presetów…</p>
            ) : (
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                <button
                  onClick={() => setStudioPreset(null)}
                  style={{
                    padding: "0.45rem 0.8rem",
                    borderRadius: 10,
                    fontSize: "0.8rem",
                    border: `1.5px solid ${studioPresetId === null ? "var(--purple)" : "var(--border)"}`,
                    background: studioPresetId === null ? "var(--purple-dim)" : "var(--bg-3)",
                    cursor: "pointer",
                    color: studioPresetId === null ? "#c4b5fd" : "var(--text-2)",
                    fontWeight: 600,
                    transition: "all 0.15s ease",
                  }}
                >
                  None
                </button>
                {presets.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setStudioPreset(p.id)}
                    title={p.config.description ?? undefined}
                    style={{
                      padding: "0.4rem 0.7rem",
                      borderRadius: 10,
                      border: `1.5px solid ${studioPresetId === p.id ? "var(--purple)" : "var(--border)"}`,
                      background: studioPresetId === p.id ? "var(--purple-dim)" : "var(--bg-3)",
                      cursor: "pointer",
                      fontSize: "0.78rem",
                      fontWeight: 600,
                      color: studioPresetId === p.id ? "#c4b5fd" : "var(--text-2)",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      transition: "all 0.15s ease",
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </Section>

          {/* ── 7. Kolekcja klipów ── */}
          <Section
            title="Kolekcja klipów"
            step={7}
            description="Zestaw klipów MP4, z których montaż układa ujęcia. Wybierz nastrój, żeby filtrować kolekcje."
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

        </div>

        {/* ════ RIGHT — video editor panel ════ */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            borderLeft: "1px solid var(--border)",
            background: "linear-gradient(180deg, var(--bg-2) 0%, var(--bg-1) 100%)",
            overflow: "hidden",
            boxShadow: "-4px 0 24px rgba(0,0,0,0.08)",
          }}
        >
          {/* ── Scrollable area: video + timeline ── */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }}>
            {/* Section: Podgląd wideo */}
            <div
              style={{
                padding: "0.7rem 0.9rem 0.5rem",
                borderBottom: "1px solid var(--border)",
                background: "rgba(0,0,0,0.02)",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <span style={{ width: 3, height: 14, borderRadius: 2, background: "var(--purple)", flexShrink: 0 }} />
              <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-2)", letterSpacing: "0.03em" }}>
                Podgląd wideo
              </span>
            </div>
            <div style={{ padding: "0 0.9rem 0.75rem", margin: "0 0.5rem", background: "var(--bg-3)", border: "1px solid var(--border)", borderTop: "none", borderRadius: "0 0 12px 12px" }}>
            <PhonePreview
              url={previewUrl}
              bpm={previewBpm}
              loading={previewLoading}
              lyricText={editedText.slice(0, 60) || null}
              lyricStyle={studioLyricStyle}
              lyricColor={studioLyricColor}
              letterbox={activePreset?.config?.letterbox ?? false}
            />
            </div>
            {/* Section: Timeline montażu */}
            {track && (
              <>
                <div
                  style={{
                    padding: "0.55rem 0.9rem 0.4rem",
                    borderBottom: "1px solid var(--border)",
                    background: "rgba(0,0,0,0.02)",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <span style={{ width: 3, height: 14, borderRadius: 2, background: "var(--purple)", flexShrink: 0 }} />
                  <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-2)", letterSpacing: "0.03em" }}>
                    Timeline montażu
                  </span>
                </div>
                <div style={{ padding: "0.6rem 0.9rem" }}>
                <EditPreviewTimeline
                  totalDuration={track.duration ? Math.min(track.duration, 60) : 20}
                  beats={previewBeats}
                  captionSegments={currentSegments ?? []}
                  hasHook={!!studioHookId || !!studioHookFolderId}
                  hookLabel={
                    studioHookFolderId
                      ? `Folder: ${moods.find((m) => m.id === studioHookFolderId)?.label ?? studioHookFolderId}`
                      : studioHookId
                        ? hooks.find((h) => h.id === studioHookId)?.text
                        : undefined
                  }
                  clipCount={collection?.clips?.length}
                />
                </div>
              </>
            )}
          </div>

          {/* ── Sticky: Generuj wideo ── */}
          <div
            style={{
              flexShrink: 0,
              borderTop: "1px solid var(--border)",
              background: "var(--bg-2)",
              boxShadow: "0 -4px 20px rgba(0,0,0,0.06)",
            }}
          >
            <div
              style={{
                padding: "0.65rem 0.9rem 0.45rem",
                borderBottom: "1px solid var(--border)",
                background: "rgba(0,0,0,0.02)",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <span style={{ width: 3, height: 14, borderRadius: 2, background: "var(--purple)", flexShrink: 0 }} />
              <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-2)", letterSpacing: "0.03em" }}>
                Generuj wideo
              </span>
            </div>
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

            <div style={{ padding: "0.85rem 0.9rem 1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {/* Seed + Preview — compact row */}
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "center",
                  padding: "0.5rem 0.65rem",
                  background: "var(--bg-3)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                }}
              >
                <span style={{ fontSize: "0.7rem", color: "var(--text-3)", flexShrink: 0 }} title="Ten sam seed = ten sam układ klipów przy ponownym generowaniu.">
                  Seed
                </span>
                <input
                  type="number"
                  placeholder="opcjonalnie"
                  value={batchSeed}
                  onChange={(e) => setBatchSeed(e.target.value)}
                  style={{
                    flex: 1,
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    fontSize: "0.8rem",
                    color: batchSeed ? "var(--text)" : "var(--text-3)",
                    minWidth: 0,
                  }}
                />
                {batchSeed && (
                  <button type="button" onClick={() => setBatchSeed("")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", fontSize: "0.7rem", padding: "0.1rem" }} aria-label="Wyczyść">✕</button>
                )}
                <button
                  type="button"
                  onClick={handlePreview}
                  disabled={!ready || previewLoading}
                  style={{
                    flexShrink: 0,
                    padding: "0.35rem 0.6rem",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--bg-2)",
                    color: "var(--text-2)",
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    cursor: ready && !previewLoading ? "pointer" : "not-allowed",
                    opacity: ready && !previewLoading ? 1 : 0.6,
                  }}
                  title="Podgląd 5 s"
                >
                  {previewLoading ? <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> : "▶ 5s"}
                </button>
              </div>

              {/* Platformy */}
              <div
                style={{
                  padding: "0.55rem 0.65rem",
                  background: "var(--bg-3)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.45rem" }}>
                  <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--text-2)" }}>
                    Platformy
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedPlatforms([...ALL_BATCH_PLATFORMS])}
                    title="Zaznacz wszystkie"
                    style={{
                      fontSize: "0.65rem",
                      fontWeight: 700,
                      color: selectedPlatforms.length === ALL_BATCH_PLATFORMS.length && ALL_BATCH_PLATFORMS.every(p => selectedPlatforms.includes(p)) ? "var(--purple)" : "var(--text-3)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "0.1rem 0.25rem",
                      borderRadius: 4,
                    }}
                  >
                    Wszystkie ×{ALL_BATCH_PLATFORMS.length}
                  </button>
                </div>
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  {PLATFORM_OPTIONS.map((p) => {
                    const active = selectedPlatforms.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => togglePlatform(p.id)}
                        title={p.label}
                        style={{
                          flex: 1,
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: "0.2rem",
                          padding: "0.4rem 0.25rem",
                          borderRadius: 8,
                          border: `1.5px solid ${active ? "var(--purple)" : "var(--border)"}`,
                          background: active ? "var(--purple-dim)" : "var(--bg-2)",
                          cursor: "pointer",
                          transition: "all 0.15s ease",
                          position: "relative",
                        }}
                      >
                        <span style={{ fontSize: "1rem", lineHeight: 1 }}>{p.emoji}</span>
                        <span style={{ fontSize: "0.6rem", fontWeight: 700, color: active ? "#c4b5fd" : "var(--text-3)", whiteSpace: "nowrap" }}>
                          {p.shortLabel}
                        </span>
                        {active && (
                          <span style={{ position: "absolute", top: 4, right: 5, width: 5, height: 5, borderRadius: "50%", background: "var(--purple)" }} />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Liczba editów */}
              <div
                style={{
                  padding: "0.55rem 0.65rem",
                  background: "var(--bg-3)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.4rem" }}>
                  <span style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--text-2)" }}>Liczba wariantów</span>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-2)", fontWeight: 700 }}>
                    {batchEditCount} × {selectedPlatforms.length} = {batchEditCount * selectedPlatforms.length} wideo
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <input
                    type="range"
                    min={1}
                    max={50}
                    step={1}
                    value={batchEditCount}
                    onChange={(e) => setBatchEditCount(Number(e.target.value))}
                    style={{ flex: 1, accentColor: "var(--purple)", height: 6 }}
                  />
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={batchEditCount}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v)) setBatchEditCount(Math.min(100, Math.max(1, v)));
                    }}
                    style={{
                      width: 48,
                      padding: "0.3rem 0.4rem",
                      background: "var(--bg-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      color: "var(--text)",
                      textAlign: "center",
                    }}
                  />
                </div>
                <p style={{ fontSize: "0.65rem", color: "var(--text-3)", marginTop: "0.3rem", lineHeight: 1.35 }}>
                  Różne układy klipów. Dla każdej platformy powstanie tyle plików.
                </p>
              </div>

              {/* Primary CTA */}
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!ready || !!batchJobId}
                style={{
                  width: "100%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.5rem",
                  padding: "0.85rem 1.1rem",
                  borderRadius: 12,
                  fontFamily: "inherit",
                  fontSize: "0.95rem",
                  fontWeight: 700,
                  border: "none",
                  cursor: ready && !batchJobId ? "pointer" : "not-allowed",
                  opacity: ready && !batchJobId ? 1 : 0.5,
                  background: "linear-gradient(135deg, #6366f1 0%, #4f46e5 50%, #4338ca 100%)",
                  color: "#fff",
                  boxShadow: ready && !batchJobId
                    ? "0 4px 20px rgba(99,102,241,0.35), 0 1px 3px rgba(0,0,0,0.2)"
                    : "none",
                  transition: "all 0.2s ease",
                  letterSpacing: "0.02em",
                }}
                onMouseEnter={(e) => {
                  if (ready && !batchJobId) {
                    (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
                    (e.currentTarget as HTMLElement).style.boxShadow = "0 8px 28px rgba(99,102,241,0.4), 0 2px 6px rgba(0,0,0,0.2)";
                  }
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.transform = "";
                  (e.currentTarget as HTMLElement).style.boxShadow = ready && !batchJobId
                    ? "0 4px 20px rgba(99,102,241,0.35), 0 1px 3px rgba(0,0,0,0.2)"
                    : "none";
                }}
              >
                {batchJobId && batchJob?.status !== "done" && batchJob?.status !== "error" ? (
                  <>
                    <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                    Generuję…
                  </>
                ) : selectedPlatforms.length > 1 ? (
                  <>✦ Generuj ×{selectedPlatforms.length} wideo</>
                ) : (
                  <>✦ Generuj wideo</>
                )}
              </button>

              {!ready && (
                <p style={{ fontSize: "0.75rem", color: "var(--text-3)", textAlign: "center", margin: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: "0.4rem" }}>
                  <span style={{ color: "var(--orange)", fontSize: "0.5rem" }}>●</span>
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
  description,
  badge,
  action,
  step,
  children,
}: {
  title: string;
  description?: string;
  badge?: string;
  action?: React.ReactNode;
  step?: number;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: "1.35rem 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "0.75rem",
          marginBottom: description ? "0.5rem" : "0.9rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", minWidth: 0 }}>
          {step != null && (
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 8,
                background: "linear-gradient(135deg, rgba(139,92,246,0.2) 0%, rgba(139,92,246,0.08) 100%)",
                border: "1px solid rgba(139,92,246,0.4)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.75rem",
                fontWeight: 800,
                color: "#c4b5fd",
                flexShrink: 0,
              }}
            >
              {step}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <h3 style={{ fontWeight: 700, fontSize: "0.95rem", margin: 0, letterSpacing: "-0.01em" }}>{title}</h3>
            {badge && (
              <span style={{ fontSize: "0.65rem", color: "var(--text-3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginLeft: "0.35rem" }}>
                {badge}
              </span>
            )}
          </div>
        </div>
        {action}
      </div>
      {description && (
        <p
          style={{ marginBottom: "0.9rem", lineHeight: 1.5, maxWidth: "42rem", fontSize: "0.8rem", color: "var(--text-3)" }}
        >
          {description}
        </p>
      )}
      {children}
    </section>
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

        {/* Przycisk: pokaż/ukryj strefę bezpieczną */}
        <button
          type="button"
          onClick={() => setShowSafeZone((s) => !s)}
          title={showSafeZone ? "Ukryj strefę bezpieczną" : "Pokaż strefę bezpieczną — gdzie trzymać napisy i twarze, żeby nie były ucięte na różnych telefonach"}
          aria-label={showSafeZone ? "Ukryj strefę bezpieczną" : "Pokaż strefę bezpieczną"}
          style={{
            position: "absolute",
            top: "0.3rem",
            right: "0.3rem",
            background: showSafeZone ? "rgba(139,92,246,0.75)" : "rgba(0,0,0,0.45)",
            border: "none",
            borderRadius: 6,
            padding: "0.25rem 0.35rem",
            fontSize: "0.7rem",
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
                strefa bezpieczna
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

/* ── Build clip segments from beats (same logic as backend) ── */
function buildClipSegmentsFromBeats(
  beats: number[],
  totalDuration: number,
): { start: number; end: number }[] {
  if (beats.length < 2) {
    const segDur = 2;
    const out: { start: number; end: number }[] = [];
    let t = 0;
    while (t < totalDuration) {
      out.push({ start: t, end: Math.min(t + segDur, totalDuration) });
      t += segDur;
    }
    return out;
  }
  const valid = beats.filter((t) => t < totalDuration);
  if (valid.length < 2) return [{ start: 0, end: totalDuration }];
  return valid.slice(0, -1).map((start, i) => ({
    start,
    end: Math.min(valid[i + 1], totalDuration),
  }));
}

/* ── Edit preview timeline (Premiere-style: klipy, napisy, hook) ── */
const HOOK_DISPLAY_DURATION = 3;

function EditPreviewTimeline({
  totalDuration,
  beats = [],
  captionSegments = [],
  hasHook,
  hookLabel,
  clipCount,
}: {
  totalDuration: number;
  beats?: number[];
  captionSegments?: { start: number; end: number; text: string }[];
  hasHook?: boolean;
  hookLabel?: string;
  clipCount?: number;
}) {
  const total = Math.max(totalDuration, 1);
  const clipSegments = buildClipSegmentsFromBeats(beats, total);
  const fmtTC = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const tickStep = total <= 20 ? 2 : total <= 60 ? 5 : 10;
  const ticks = Array.from(
    { length: Math.floor(total / tickStep) + 1 },
    (_, i) => Math.min(i * tickStep, total),
  );

  const trackHeight = 32;
  const labelWidth = 72;

  return (
    <div
      style={{
        background: "var(--bg-3)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "0.4rem 0.6rem",
          borderBottom: "1px solid var(--border)",
          fontSize: "0.65rem",
          fontWeight: 700,
          color: "var(--text-3)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Podgląd montażu — które klipy i tekst od kiedy do kiedy
      </div>

      {/* Time ruler */}
      <div
        style={{
          display: "flex",
          height: 22,
          background: "var(--bg-4)",
          borderBottom: "1px solid var(--border)",
          position: "relative",
        }}
      >
        <div style={{ width: labelWidth, flexShrink: 0 }} />
        <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          {ticks.map((t) => (
            <div
              key={t}
              style={{
                position: "absolute",
                left: `${(t / total) * 100}%`,
                transform: "translateX(-50%)",
                fontSize: "0.6rem",
                color: "var(--text-3)",
                fontFamily: "monospace",
              }}
            >
              {fmtTC(t)}
            </div>
          ))}
        </div>
      </div>

      {/* Track: Klipy */}
      <div
        style={{
          display: "flex",
          height: trackHeight,
          borderBottom: "1px solid var(--border)",
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            width: labelWidth,
            flexShrink: 0,
            paddingLeft: "0.4rem",
            display: "flex",
            alignItems: "center",
            fontSize: "0.7rem",
            color: "var(--text-3)",
            fontWeight: 600,
          }}
        >
          Klipy
        </div>
        <div style={{ flex: 1, position: "relative", minWidth: 0, background: "var(--bg-4)" }}>
          {clipSegments.map((seg, i) => {
            const w = Math.max(((seg.end - seg.start) / total) * 100, 2);
            const left = (seg.start / total) * 100;
            return (
              <div
                key={i}
                title={`${fmtTC(seg.start)} – ${fmtTC(seg.end)} (${(seg.end - seg.start).toFixed(1)} s)`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  width: `${w}%`,
                  height: "100%",
                  margin: "2px 0",
                  background: i % 2 === 0 ? "rgba(139,92,246,0.5)" : "rgba(139,92,246,0.3)",
                  borderRight: "1px solid rgba(139,92,246,0.4)",
                  borderRadius: "0 3px 3px 0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.6rem",
                  fontWeight: 700,
                  color: "rgba(255,255,255,0.95)",
                  overflow: "hidden",
                }}
              >
                {clipCount != null ? `Klip ${(i % clipCount) + 1}` : i + 1}
              </div>
            );
          })}
        </div>
      </div>

      {/* Track: Napisy */}
      <div
        style={{
          display: "flex",
          height: trackHeight,
          borderBottom: hasHook ? "1px solid var(--border)" : "none",
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            width: labelWidth,
            flexShrink: 0,
            paddingLeft: "0.4rem",
            display: "flex",
            alignItems: "center",
            fontSize: "0.7rem",
            color: "var(--text-3)",
            fontWeight: 600,
          }}
        >
          Napisy
        </div>
        <div style={{ flex: 1, position: "relative", minWidth: 0, background: "var(--bg-4)" }}>
          {captionSegments.slice(0, 50).map((seg, i) => {
            const w = Math.max(((seg.end - seg.start) / total) * 100, 1);
            const left = (seg.start / total) * 100;
            return (
              <div
                key={i}
                title={`${fmtTC(seg.start)} – ${fmtTC(seg.end)}: ${seg.text}`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  width: `${w}%`,
                  height: "100%",
                  margin: "2px 0",
                  background: "rgba(34,197,94,0.4)",
                  borderRight: "1px solid rgba(34,197,94,0.5)",
                  borderRadius: "0 3px 3px 0",
                  padding: "0 4px",
                  display: "flex",
                  alignItems: "center",
                  fontSize: "0.55rem",
                  color: "rgba(255,255,255,0.95)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {seg.text.slice(0, 12)}{seg.text.length > 12 ? "…" : ""}
              </div>
            );
          })}
        </div>
      </div>

      {/* Track: Hook */}
      {hasHook && (
        <div
          style={{
            display: "flex",
            height: trackHeight,
            alignItems: "stretch",
          }}
        >
          <div
            style={{
              width: labelWidth,
              flexShrink: 0,
              paddingLeft: "0.4rem",
              display: "flex",
              alignItems: "center",
              fontSize: "0.7rem",
              color: "var(--text-3)",
              fontWeight: 600,
            }}
          >
            Hook
          </div>
          <div style={{ flex: 1, position: "relative", minWidth: 0, background: "var(--bg-4)" }}>
            <div
              title={`0:00 – ${fmtTC(HOOK_DISPLAY_DURATION)}: ${hookLabel ?? "Hook"}`}
              style={{
                position: "absolute",
                left: 0,
                width: `${Math.min((HOOK_DISPLAY_DURATION / total) * 100, 100)}%`,
                height: "100%",
                margin: "2px 0",
                background: "rgba(251,191,36,0.45)",
                borderRight: "1px solid rgba(251,191,36,0.6)",
                borderRadius: "0 3px 3px 0",
                padding: "0 6px",
                display: "flex",
                alignItems: "center",
                fontSize: "0.6rem",
                fontWeight: 600,
                color: "rgba(0,0,0,0.85)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {hookLabel ? (hookLabel.length > 14 ? hookLabel.slice(0, 14) + "…" : hookLabel) : "POV / CTA"}
            </div>
          </div>
        </div>
      )}
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

/* ── Layers panel & Add Text modal ──────────────────────── */

const LAYER_TYPE_LABELS: Record<string, string> = {
  video_base: "Video",
  hook: "Hook",
  lyrics: "Lyrics",
  custom_text: "Text",
  cinematic_bars: "Bars",
  color_grade: "Color",
};

function LayersList({
  layers,
  onReorder,
  onRemove,
}: {
  layers: CompositionLayer[];
  onReorder: (layers: CompositionLayer[]) => void;
  onRemove: (id: string) => void;
}) {
  const sorted = [...layers].sort((a, b) => a.zIndex - b.zIndex);

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= sorted.length) return;
    const next = [...sorted];
    [next[index], next[target]] = [next[target]!, next[index]!];
    const reindexed = next.map((l, i) => ({ ...l, zIndex: i }));
    onReorder(reindexed);
  };

  return (
    <div
      style={{
        background: "var(--bg-3)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        maxHeight: 220,
        overflowY: "auto",
      }}
    >
      {sorted.map((layer, index) => (
        <div
          key={layer.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "0.4rem 0.6rem",
            borderBottom: index < sorted.length - 1 ? "1px solid var(--border)" : "none",
          }}
        >
          <span style={{ fontSize: "0.65rem", color: "var(--text-3)", minWidth: 18 }}>{layer.zIndex}</span>
          <span style={{ flex: 1, fontSize: "0.78rem", fontWeight: 600 }}>
            {LAYER_TYPE_LABELS[layer.type] ?? layer.type}
            {layer.type === "custom_text" && (layer.config as unknown as CustomTextConfig)?.text && (
              <span style={{ fontWeight: 400, color: "var(--text-2)", marginLeft: "0.35rem" }}>
                “{(layer.config as unknown as CustomTextConfig).text.slice(0, 20)}{(layer.config as unknown as CustomTextConfig).text.length > 20 ? "…" : ""}”
              </span>
            )}
          </span>
          <span style={{ fontSize: "0.6rem", color: "var(--text-3)" }}>
            {layer.start.toFixed(1)}s–{layer.end.toFixed(1)}s
          </span>
          <div style={{ display: "flex", gap: "0.2rem" }}>
            <button
              type="button"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              style={{
                padding: "0.15rem 0.35rem",
                fontSize: "0.7rem",
                border: "1px solid var(--border)",
                borderRadius: 4,
                background: "var(--bg-4)",
                cursor: index === 0 ? "default" : "pointer",
                opacity: index === 0 ? 0.5 : 1,
              }}
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={index === sorted.length - 1}
              style={{
                padding: "0.15rem 0.35rem",
                fontSize: "0.7rem",
                border: "1px solid var(--border)",
                borderRadius: 4,
                background: "var(--bg-4)",
                cursor: index === sorted.length - 1 ? "default" : "pointer",
                opacity: index === sorted.length - 1 ? 0.5 : 1,
              }}
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => onRemove(layer.id)}
              disabled={layer.type === "video_base"}
              title="Remove layer"
              style={{
                padding: "0.15rem 0.35rem",
                fontSize: "0.7rem",
                border: "none",
                borderRadius: 4,
                background: "rgba(239,68,68,0.15)",
                color: "var(--red)",
                cursor: layer.type === "video_base" ? "default" : "pointer",
                opacity: layer.type === "video_base" ? 0.5 : 1,
              }}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function AddTextButton({
  composition,
  onAdd,
}: {
  composition: Composition;
  onAdd: (layer: CompositionLayer) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [font, _setFont] = useState("arial");
  const [fontSize, setFontSize] = useState(48);
  const [color, setColor] = useState("#FFFFFF");
  const [bgBox, setBgBox] = useState(true);
  const [position, setPosition] = useState<"top" | "center" | "bottom" | "custom">("center");
  const [animation, setAnimation] = useState<"pop" | "slide" | "fade">("pop");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(5);

  const maxZ = composition.layers.length ? Math.max(...composition.layers.map((l) => l.zIndex)) : 0;

  const handleAdd = () => {
    if (!text.trim()) return;
    const layer: CompositionLayer = {
      id: uid(),
      type: "custom_text",
      start,
      end: Math.max(end, start + 0.5),
      zIndex: maxZ + 1,
      config: {
        text: text.trim(),
        font,
        fontSize,
        color,
        bgBox,
        position,
        animation,
      } as Record<string, unknown>,
    };
    onAdd(layer);
    setOpen(false);
    setText("");
    setStart(0);
    setEnd(5);
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(true)}
        style={{ fontSize: "0.72rem" }}
      >
        + Add Text
      </button>
      {open && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
          onClick={() => setOpen(false)}
        >
          <div
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "1.25rem",
              maxWidth: 380,
              width: "90%",
              maxHeight: "85vh",
              overflowY: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 1rem", fontSize: "1rem" }}>Add text overlay</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div>
                <label className="label">Text</label>
                <input
                  type="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Your text"
                  className="input"
                  style={{ width: "100%", marginTop: "0.25rem" }}
                />
              </div>
              <div>
                <label className="label">Position</label>
                <select
                  value={position}
                  onChange={(e) => setPosition(e.target.value as typeof position)}
                  style={{ width: "100%", marginTop: "0.25rem", padding: "0.4rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg-3)" }}
                >
                  <option value="top">Top</option>
                  <option value="center">Center</option>
                  <option value="bottom">Bottom</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div>
                <label className="label">Animation</label>
                <select
                  value={animation}
                  onChange={(e) => setAnimation(e.target.value as typeof animation)}
                  style={{ width: "100%", marginTop: "0.25rem", padding: "0.4rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg-3)" }}
                >
                  <option value="pop">Pop</option>
                  <option value="slide">Slide</option>
                  <option value="fade">Fade</option>
                </select>
              </div>
              <div style={{ display: "flex", gap: "0.75rem" }}>
                <div style={{ flex: 1 }}>
                  <label className="label">Start (s)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={start}
                    onChange={(e) => setStart(parseFloat(e.target.value) || 0)}
                    style={{ width: "100%", marginTop: "0.25rem", padding: "0.4rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg-3)" }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="label">End (s)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={end}
                    onChange={(e) => setEnd(parseFloat(e.target.value) || 0)}
                    style={{ width: "100%", marginTop: "0.25rem", padding: "0.4rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg-3)" }}
                  />
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input
                  type="checkbox"
                  id="bgbox"
                  checked={bgBox}
                  onChange={(e) => setBgBox(e.target.checked)}
                />
                <label htmlFor="bgbox" className="label" style={{ margin: 0 }}>Background box</label>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <label className="label" style={{ margin: 0 }}>Color</label>
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  style={{ width: 32, height: 28, padding: 0, border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer" }}
                />
                <input
                  type="number"
                  min={12}
                  max={200}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value) || 48)}
                  style={{ width: 56, padding: "0.3rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg-3)", fontSize: "0.8rem" }}
                />
                <span style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>px</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "1.25rem", justifyContent: "flex-end" }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={handleAdd} disabled={!text.trim()}>
                Add layer
              </button>
            </div>
          </div>
        </div>
      )}
    </>
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
                background: "linear-gradient(90deg, var(--orange), var(--accent-amber))",
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
              <span style={{ fontSize: "0.72rem", color: "var(--accent)", fontWeight: 700 }}>{pct}%</span>
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
