/**
 * UploadForm component
 *
 * Handles:
 *  - Music file drop/select (.mp3/.wav)
 *  - Multiple video clip drop/select
 *  - Caption style selection
 *  - Preview duration slider
 *  - Calls onUploadComplete when both uploads have finished
 */

import React, { useCallback, useRef, useState } from "react";
import { uploadMusic, uploadClips } from "../lib/api";
import type { UploadMusicResponse, UploadClipsResponse } from "../lib/api";

export interface UploadResult {
  musicId: string;
  clipsId: string;
  captionStyle: "bold_center" | "karaoke" | "minimal_clean";
  previewDuration: number;
}

interface Props {
  onUploadComplete: (result: UploadResult) => void;
}

const CAPTION_STYLES = [
  {
    id: "bold_center" as const,
    label: "Bold Center",
    description: "Large white bold text, centred with a strong outline",
    icon: "⬛",
  },
  {
    id: "karaoke" as const,
    label: "Karaoke",
    description: "Word-level highlighting in yellow on each beat",
    icon: "🎤",
  },
  {
    id: "minimal_clean" as const,
    label: "Minimal Clean",
    description: "Small semi-transparent pill at the bottom edge",
    icon: "✨",
  },
];

const ALLOWED_AUDIO = [".mp3", ".wav", ".aac", ".flac", ".m4a"];
const ALLOWED_VIDEO = [".mp4", ".mov", ".avi", ".mkv", ".webm"];

export default function UploadForm({ onUploadComplete }: Props) {
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [clipFiles, setClipFiles] = useState<File[]>([]);
  const [captionStyle, setCaptionStyle] = useState<
    "bold_center" | "karaoke" | "minimal_clean"
  >("bold_center");
  const [previewDuration, setPreviewDuration] = useState(5);

  const [musicDragging, setMusicDragging] = useState(false);
  const [clipsDragging, setClipsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStep, setUploadStep] = useState<
    "idle" | "music" | "clips" | "done"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  const musicInputRef = useRef<HTMLInputElement>(null);
  const clipsInputRef = useRef<HTMLInputElement>(null);

  // ---- Music drop handlers ----

  const onMusicDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setMusicDragging(false);
    const file = e.dataTransfer.files[0];
    if (
      file &&
      ALLOWED_AUDIO.some((ext) => file.name.toLowerCase().endsWith(ext))
    ) {
      setMusicFile(file);
    } else {
      setError("Unsupported audio format. Use MP3, WAV, AAC, FLAC, or M4A.");
    }
  }, []);

  // ---- Clips drop handlers ----

  const onClipsDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setClipsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      ALLOWED_VIDEO.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
    if (files.length === 0) {
      setError("No valid video files found. Use MP4, MOV, AVI, MKV, or WEBM.");
      return;
    }
    setClipFiles((prev) => [...prev, ...files].slice(0, 20));
  }, []);

  const removeClip = (idx: number) =>
    setClipFiles((prev) => prev.filter((_, i) => i !== idx));

  // ---- Submit ----

  const handleSubmit = async () => {
    if (!musicFile || clipFiles.length === 0) return;
    setError(null);
    setUploading(true);

    try {
      setUploadStep("music");
      const musicRes: UploadMusicResponse = await uploadMusic(musicFile);

      setUploadStep("clips");
      const clipsRes: UploadClipsResponse = await uploadClips(clipFiles);

      setUploadStep("done");
      onUploadComplete({
        musicId: musicRes.music_id,
        clipsId: clipsRes.clips_id,
        captionStyle,
        previewDuration,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const formatSize = (bytes: number) =>
    bytes < 1_048_576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem" }}>
      {/* ---- Music upload ---- */}
      <div className="card">
        <h2 style={{ marginBottom: "1rem", fontSize: "1rem", fontWeight: 700 }}>
          🎵 Music Track
        </h2>
        <div
          className={`dropzone ${musicDragging ? "active" : ""} ${musicFile ? "accepted" : ""}`}
          onClick={() => musicInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setMusicDragging(true);
          }}
          onDragLeave={() => setMusicDragging(false)}
          onDrop={onMusicDrop}
        >
          <input
            ref={musicInputRef}
            type="file"
            accept={ALLOWED_AUDIO.join(",")}
            style={{ display: "none" }}
            onChange={(e) => setMusicFile(e.target.files?.[0] ?? null)}
          />
          {musicFile ? (
            <div>
              <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>✅</div>
              <p className="font-semibold">{musicFile.name}</p>
              <p className="text-sm text-secondary">
                {formatSize(musicFile.size)}
              </p>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>
                🎵
              </div>
              <p className="font-semibold">Drop your music file here</p>
              <p className="text-sm text-secondary mt-2">
                MP3 · WAV · AAC · FLAC · M4A — max 100 MB
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ---- Clips upload ---- */}
      <div className="card">
        <h2 style={{ marginBottom: "1rem", fontSize: "1rem", fontWeight: 700 }}>
          🎬 Video Clips
        </h2>
        <div
          className={`dropzone ${clipsDragging ? "active" : ""} ${clipFiles.length > 0 ? "accepted" : ""}`}
          onClick={() => clipsInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setClipsDragging(true);
          }}
          onDragLeave={() => setClipsDragging(false)}
          onDrop={onClipsDrop}
          style={{ marginBottom: clipFiles.length > 0 ? "1rem" : 0 }}
        >
          <input
            ref={clipsInputRef}
            type="file"
            accept={ALLOWED_VIDEO.join(",")}
            multiple
            style={{ display: "none" }}
            onChange={(e) =>
              setClipFiles((prev) =>
                [...prev, ...Array.from(e.target.files ?? [])].slice(0, 20),
              )
            }
          />
          <div>
            <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>🎞️</div>
            <p className="font-semibold">Drop clips here or click to browse</p>
            <p className="text-sm text-secondary mt-2">
              MP4 · MOV · AVI · MKV · WEBM — 2–5 s clips work best · max 20
              files
            </p>
          </div>
        </div>

        {clipFiles.length > 0 && (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
          >
            {clipFiles.map((f, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.5rem 0.75rem",
                  background: "var(--bg-base)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border)",
                }}
              >
                <span className="text-sm">
                  <span style={{ marginRight: "0.5rem" }}>🎬</span>
                  {f.name}
                </span>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                  }}
                >
                  <span className="text-xs text-muted">
                    {formatSize(f.size)}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeClip(i);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--accent-red)",
                      cursor: "pointer",
                      fontSize: "1rem",
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Caption style ---- */}
      <div className="card">
        <h2 style={{ marginBottom: "1rem", fontSize: "1rem", fontWeight: 700 }}>
          💬 Caption Style
        </h2>
        <div className="grid-3">
          {CAPTION_STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() => setCaptionStyle(s.id)}
              style={{
                background:
                  captionStyle === s.id
                    ? "rgba(124,58,237,0.15)"
                    : "var(--bg-base)",
                border: `2px solid ${captionStyle === s.id ? "var(--accent-purple)" : "var(--border)"}`,
                borderRadius: "var(--radius-md)",
                padding: "1rem",
                cursor: "pointer",
                textAlign: "left",
                transition: "all var(--transition)",
              }}
            >
              <div style={{ fontSize: "1.5rem", marginBottom: "0.4rem" }}>
                {s.icon}
              </div>
              <p
                style={{
                  fontWeight: 700,
                  fontSize: "0.88rem",
                  color:
                    captionStyle === s.id
                      ? "var(--accent-purple-light)"
                      : "var(--text-primary)",
                  marginBottom: "0.3rem",
                }}
              >
                {s.label}
              </p>
              <p
                style={{
                  fontSize: "0.76rem",
                  color: "var(--text-muted)",
                  lineHeight: 1.4,
                }}
              >
                {s.description}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* ---- Preview duration ---- */}
      <div className="card">
        <h2 style={{ marginBottom: "1rem", fontSize: "1rem", fontWeight: 700 }}>
          ⏱️ Preview Duration
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={previewDuration}
            onChange={(e) => setPreviewDuration(Number(e.target.value))}
            style={{ flex: 1, accentColor: "var(--accent-purple)" }}
          />
          <span
            style={{
              minWidth: "3rem",
              fontWeight: 700,
              color: "var(--accent-purple-light)",
              fontSize: "1.1rem",
            }}
          >
            {previewDuration}s
          </span>
        </div>
        <p className="text-xs text-muted mt-2">
          Low-resolution 360×640 preview rendered before the full 1080×1920
          export.
        </p>
      </div>

      {/* ---- Error ---- */}
      {error && (
        <div
          style={{
            padding: "0.85rem 1rem",
            background: "rgba(239,68,68,0.1)",
            border: "1px solid var(--accent-red)",
            borderRadius: "var(--radius-sm)",
            color: "var(--accent-red)",
            fontSize: "0.88rem",
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* ---- Upload step feedback ---- */}
      {uploading && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <div className="spinner" />
          <span className="text-sm text-secondary">
            {uploadStep === "music" && "Uploading music…"}
            {uploadStep === "clips" && "Uploading clips…"}
          </span>
        </div>
      )}

      {/* ---- Submit ---- */}
      <button
        className="btn btn-primary btn-lg w-full"
        onClick={handleSubmit}
        disabled={uploading || !musicFile || clipFiles.length === 0}
        style={{ justifyContent: "center" }}
      >
        {uploading ? (
          <>
            <div
              className="spinner"
              style={{ width: 16, height: 16, borderWidth: 2 }}
            />
            Uploading…
          </>
        ) : (
          "Upload & Continue →"
        )}
      </button>
    </div>
  );
}
