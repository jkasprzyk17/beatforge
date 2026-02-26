/**
 * Library (Pliki MP3) — upload music tracks + inline transcription preview.
 *
 * After upload, user can click "Transcribe" to run Whisper locally.
 * Transcription result is displayed inline: full text + timestamp segments.
 * Result is cached in AppContext so Studio doesn't re-run it.
 */

import React, { useRef, useState, useEffect, useCallback } from "react";
import { useApp } from "../context/AppContext";
import type { Track, TranscriptionSegment } from "../context/AppContext";
import { uploadMusic, transcribeTrack, deleteTrack, trackAudioUrl } from "../lib/api";

interface Props {
  onGoToStudio: () => void;
}

const fmt    = (b: number) => b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default function Library({ onGoToStudio }: Props) {
  const {
    tracks, addTrack, removeTrack,
    setStudioTrack, studioTrackId,
    transcriptions, setTranscription,
  } = useApp();

  const [uploading, setUploading] = useState(false);
  const [drag,      setDrag]      = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const file = files[0];
    const allowed = [".mp3", ".wav", ".aac", ".flac", ".m4a"];
    if (!allowed.some(e => file.name.toLowerCase().endsWith(e))) {
      setError("Nieobsługiwany format. Użyj MP3, WAV, AAC, FLAC lub M4A.");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const res = await uploadMusic(file);
      addTrack({
        id: res.music_id, name: file.name.replace(/\.[^.]+$/, ""),
        size: file.size, musicId: res.music_id, uploadedAt: new Date(),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Błąd uploadu.");
    } finally {
      setUploading(false);
    }
  };

  const useInStudio = (id: string) => {
    setStudioTrack(id);
    onGoToStudio();
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">🎵 Pliki MP3</h1>
        <p className="page-subtitle">Uploaduj tracki — Whisper automatycznie transkrybuje tekst</p>
      </div>

      <div className="page-body">
        {/* Drop zone */}
        <div
          className={`dropzone mb-4 ${drag ? "drag" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files); }}
        >
          <input
            ref={inputRef} type="file"
            accept=".mp3,.wav,.aac,.flac,.m4a"
            style={{ display: "none" }}
            onChange={e => handleFiles(e.target.files)}
          />
          {uploading ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem" }}>
              <div className="spinner" style={{ width: 28, height: 28 }} />
              <p className="dropzone-sub pulse">Uploaduję track…</p>
            </div>
          ) : (
            <>
              <div className="dropzone-icon">🎵</div>
              <p className="dropzone-title">Upuść plik audio lub kliknij</p>
              <p className="dropzone-sub">MP3 · WAV · AAC · FLAC · M4A — maks. 100 MB</p>
            </>
          )}
        </div>

        {error && (
          <div style={{
            padding: "0.75rem 1rem", marginBottom: "1rem",
            background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "var(--radius)", color: "var(--red)", fontSize: "0.85rem",
          }}>
            ⚠️ {error}
          </div>
        )}

        {/* Track list */}
        {tracks.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">🎼</div>
            <p className="empty-title">Brak tracków</p>
            <p className="empty-sub">Uploaduj pierwszy plik audio żeby zacząć</p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {tracks.map(t => (
              <TrackCard
                key={t.id}
                track={t}
                active={studioTrackId === t.id}
                cachedSegments={transcriptions[t.musicId] ?? null}
                onUse={() => useInStudio(t.id)}
                onRemove={async () => {
                    try {
                      await deleteTrack(t.id);
                    } catch {
                      setError("Nie udało się usunąć tracku");
                      return;
                    }
                    removeTrack(t.id);
                  }}
                onTranscribed={(segs) => setTranscription(t.musicId, segs)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Mini audio player ─────────────────────────────────────

function MiniPlayer({ musicId }: { musicId: string }) {
  const audioRef   = useRef<HTMLAudioElement>(null);
  const [playing,  setPlaying]  = useState(false);
  const [progress, setProgress] = useState(0);     // 0–1
  const [current,  setCurrent]  = useState(0);
  const [total,    setTotal]    = useState(0);
  const [loading,  setLoading]  = useState(false);

  const url = trackAudioUrl(musicId);

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      setLoading(true);
      a.play().then(() => setLoading(false)).catch(() => setLoading(false));
    } else {
      a.pause();
    }
  }, []);

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !a.duration) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * a.duration;
  };

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay    = () => setPlaying(true);
    const onPause   = () => setPlaying(false);
    const onEnded   = () => { setPlaying(false); setProgress(0); setCurrent(0); };
    const onLoaded  = () => setTotal(a.duration || 0);
    const onTime    = () => {
      if (a.duration) {
        setCurrent(a.currentTime);
        setProgress(a.currentTime / a.duration);
      }
    };
    a.addEventListener("play",              onPlay);
    a.addEventListener("pause",             onPause);
    a.addEventListener("ended",             onEnded);
    a.addEventListener("loadedmetadata",    onLoaded);
    a.addEventListener("timeupdate",        onTime);
    return () => {
      a.removeEventListener("play",           onPlay);
      a.removeEventListener("pause",          onPause);
      a.removeEventListener("ended",          onEnded);
      a.removeEventListener("loadedmetadata", onLoaded);
      a.removeEventListener("timeupdate",     onTime);
    };
  }, []);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "0.65rem",
      padding: "0.6rem 1rem",
      borderTop: "1px solid var(--border)",
      background: "var(--bg-3)",
    }}>
      <audio ref={audioRef} src={url} preload="metadata" />

      {/* Play / Pause button */}
      <button
        onClick={toggle}
        style={{
          width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
          background: playing ? "var(--purple)" : "var(--bg-4)",
          border: `1.5px solid ${playing ? "var(--purple)" : "var(--border)"}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", transition: "all var(--t)",
          boxShadow: playing ? "0 0 10px var(--purple-glow)" : "none",
          color: playing ? "#fff" : "var(--text-2)",
          fontSize: "0.7rem",
        }}
        title={playing ? "Pause" : "Play"}
      >
        {loading ? (
          <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
        ) : playing ? "⏸" : "▶"}
      </button>

      {/* Time */}
      <span style={{ fontSize: "0.7rem", fontFamily: "monospace", color: "var(--text-3)", whiteSpace: "nowrap", minWidth: "2.8rem" }}>
        {fmtTime(current)}
      </span>

      {/* Progress bar */}
      <div
        onClick={seek}
        style={{
          flex: 1, height: 4, borderRadius: 4,
          background: "var(--bg-4)", cursor: "pointer", position: "relative", overflow: "hidden",
        }}
      >
        <div style={{
          position: "absolute", left: 0, top: 0, height: "100%",
          width: `${progress * 100}%`,
          background: "var(--purple)",
          transition: "width 0.1s linear",
          borderRadius: 4,
        }} />
      </div>

      {/* Duration */}
      <span style={{ fontSize: "0.7rem", fontFamily: "monospace", color: "var(--text-3)", whiteSpace: "nowrap", minWidth: "2.8rem", textAlign: "right" }}>
        {total ? fmtTime(total) : "--:--"}
      </span>
    </div>
  );
}

// ── TrackCard with inline transcription ───────────────────

function TrackCard({
  track, active, cachedSegments,
  onUse, onRemove, onTranscribed,
}: {
  track:           Track;
  active:          boolean;
  cachedSegments:  TranscriptionSegment[] | null;
  onUse:           () => void;
  onRemove:        () => void;
  onTranscribed:   (segs: TranscriptionSegment[]) => void;
}) {
  const [expanded,     setExpanded]     = useState(false);
  const [showPlayer,   setShowPlayer]   = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcriptErr, setTranscriptErr] = useState<string | null>(null);
  const [duration,     setDuration]     = useState<number | null>(null);

  const segments = cachedSegments;
  const fullText = segments?.map(s => s.text).join(" ") ?? "";

  const handleTranscribe = async () => {
    setTranscribing(true);
    setTranscriptErr(null);
    setExpanded(true);
    try {
      const res = await transcribeTrack(track.musicId);
      onTranscribed(res.segments);
      if (res.duration) setDuration(res.duration);
    } catch (e: unknown) {
      setTranscriptErr(e instanceof Error ? e.message : "Błąd transkrypcji.");
    } finally {
      setTranscribing(false);
    }
  };

  return (
    <div style={{
      background: "var(--bg-2)",
      border: `1.5px solid ${active ? "var(--purple)" : "var(--border)"}`,
      borderRadius: "var(--radius)",
      overflow: "hidden",
      transition: "border-color var(--t)",
    }}>
      {/* Main row */}
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "0.85rem 1rem" }}>
        {/* Play button / icon */}
        <button
          onClick={() => setShowPlayer(v => !v)}
          title={showPlayer ? "Ukryj odtwarzacz" : "Odtwórz podgląd"}
          style={{
            width: 44, height: 44, borderRadius: 10, flexShrink: 0,
            background: showPlayer ? "var(--purple)" : (active ? "var(--purple)" : "var(--bg-4)"),
            border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: showPlayer ? "1rem" : "1.1rem",
            boxShadow: (showPlayer || active) ? "0 0 12px var(--purple-glow)" : "none",
            transition: "all var(--t)",
            color: (showPlayer || active) ? "#fff" : "var(--text-2)",
          }}
        >
          {showPlayer ? "⏹" : "▶"}
        </button>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="truncate" style={{ fontWeight: 600, fontSize: "0.9rem" }}>{track.name}</p>
          <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
            <span className="badge badge-gray">{fmt(track.size)}</span>
            {(track.duration || duration) && (
              <span className="badge badge-gray">⏱ {fmtDur(track.duration ?? duration ?? 0)}</span>
            )}
            {track.bpm && <span className="badge badge-purple">🥁 {track.bpm} BPM</span>}
            {active && <span className="badge badge-green">✓ W studio</span>}
            {segments && (
              <span className="badge" style={{ background: "rgba(6,182,212,0.15)", color: "var(--cyan)" }}>
                📝 transkrypcja
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
          {/* Transcribe / expand */}
          {segments ? (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setExpanded(v => !v)}
              title="Pokaż/ukryj transkrypcję"
            >
              {expanded ? "▲ Tekst" : "▼ Tekst"}
            </button>
          ) : (
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleTranscribe}
              disabled={transcribing}
              title="Transkrybuj lokalnie (Whisper)"
            >
              {transcribing
                ? <><div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Transcribe…</>
                : "📝 Transcribe"
              }
            </button>
          )}

          <button
            className={`btn btn-sm ${active ? "btn-ghost" : "btn-primary"}`}
            onClick={onUse}
          >
            {active ? "Wybrano" : "→ Studio"}
          </button>

          <button className="btn btn-sm btn-danger" onClick={onRemove}>✕</button>
        </div>
      </div>

      {/* Audio player panel */}
      {showPlayer && <MiniPlayer musicId={track.musicId} />}

      {/* Transcription panel */}
      {(expanded || transcribing || transcriptErr) && (
        <div style={{
          borderTop: "1px solid var(--border)",
          padding: "0.85rem 1rem",
          background: "var(--bg-3)",
        }}>
          {transcribing && (
            <div>
              {/* Progress bar */}
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.75rem" }}>
                <div className="spinner" />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                    <span className="text-xs text-3 pulse">Whisper transkrybuje lokalnie…</span>
                    <span className="text-xs text-3">offline · bezpłatny</span>
                  </div>
                  <div className="progress">
                    <div className="progress-fill" style={{ width: "100%", animation: "none", opacity: 0.5 }} />
                  </div>
                </div>
              </div>
              <p className="text-xs text-3">
                Pierwsze uruchomienie pobiera model Whisper (~150 MB). Kolejne są szybkie.
              </p>
            </div>
          )}

          {transcriptErr && (
            <div style={{ color: "var(--red)", fontSize: "0.82rem" }}>
              ⚠ {transcriptErr}
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleTranscribe}
                style={{ marginLeft: "0.75rem" }}
              >
                Spróbuj ponownie
              </button>
            </div>
          )}

          {segments && !transcribing && (
            <TranscriptionPreview segments={segments} fullText={fullText} onRetranscribe={handleTranscribe} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Transcription preview panel ───────────────────────────

function TranscriptionPreview({
  segments, fullText, onRetranscribe,
}: {
  segments:       TranscriptionSegment[];
  fullText:       string;
  onRetranscribe: () => void;
}) {
  const isWordMode = segments[0]?.word === true;
  type View = "text" | "words" | "segments";
  const [view, setView] = useState<View>(isWordMode ? "words" : "text");

  const fmtTime = (s: number) => {
    const m  = Math.floor(s / 60);
    const sc = (s % 60).toFixed(1);
    return `${m}:${sc.padStart(4, "0")}`;
  };

  const tabs: { id: View; label: string }[] = [
    { id: "text",     label: "Pełny tekst" },
    ...(isWordMode
      ? [{ id: "words" as View, label: `Słowa (${segments.length})` }]
      : [{ id: "segments" as View, label: `Segmenty (${segments.length})` }]),
  ];

  return (
    <div>
      {/* Tab bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.65rem" }}>
        <div style={{ display: "flex", gap: "0.35rem" }}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              style={{
                padding: "0.2rem 0.6rem", borderRadius: "var(--radius)",
                fontSize: "0.72rem", fontWeight: 600, cursor: "pointer",
                border: `1px solid ${view === t.id ? "var(--cyan)" : "var(--border)"}`,
                background: view === t.id ? "rgba(6,182,212,0.12)" : "var(--bg-4)",
                color: view === t.id ? "var(--cyan)" : "var(--text-3)",
                transition: "all var(--t)",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onRetranscribe}
          title="Transkrybuj ponownie"
          style={{ fontSize: "0.72rem" }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Full text view */}
      {view === "text" && (
        <div style={{
          padding: "0.75rem",
          background: "var(--bg-4)",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          fontSize: "0.85rem",
          lineHeight: 1.85,
          color: "var(--text-2)",
          maxHeight: 180,
          overflowY: "auto",
        }}>
          {fullText || <span className="text-3">Brak tekstu</span>}
        </div>
      )}

      {/* Word-by-word karaoke view */}
      {view === "words" && (
        <div style={{
          display: "flex", flexWrap: "wrap", gap: "0.35rem",
          maxHeight: 220, overflowY: "auto",
          padding: "0.5rem",
          background: "var(--bg-4)",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
        }}>
          {segments.map((seg, i) => (
            <div
              key={i}
              title={`${fmtTime(seg.start)} → ${fmtTime(seg.end)}`}
              style={{
                display: "inline-flex", flexDirection: "column", alignItems: "center",
                padding: "0.2rem 0.5rem",
                background: "var(--bg-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                cursor: "default",
                transition: "border-color var(--t), background var(--t)",
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "var(--cyan)";
                (e.currentTarget as HTMLDivElement).style.background  = "rgba(6,182,212,0.08)";
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border)";
                (e.currentTarget as HTMLDivElement).style.background  = "var(--bg-2)";
              }}
            >
              <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text-1)" }}>
                {seg.text}
              </span>
              <span style={{ fontSize: "0.58rem", fontFamily: "monospace", color: "var(--cyan)", marginTop: 1 }}>
                {fmtTime(seg.start)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Segment list view (non-word mode fallback) */}
      {view === "segments" && (
        <div style={{
          display: "flex", flexDirection: "column", gap: "0.25rem",
          maxHeight: 200, overflowY: "auto",
        }}>
          {segments.map((seg, i) => (
            <div key={i} style={{
              display: "flex", gap: "0.6rem", alignItems: "flex-start",
              padding: "0.35rem 0.6rem",
              background: i % 2 === 0 ? "var(--bg-4)" : "transparent",
              borderRadius: 6,
            }}>
              <span style={{
                fontSize: "0.65rem", fontFamily: "monospace", color: "var(--cyan)",
                fontWeight: 700, whiteSpace: "nowrap", marginTop: "0.15rem",
              }}>
                {fmtTime(seg.start)}
              </span>
              <span style={{ fontSize: "0.82rem", color: "var(--text-2)", lineHeight: 1.5 }}>
                {seg.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
