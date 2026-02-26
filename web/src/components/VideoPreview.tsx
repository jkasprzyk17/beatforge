/**
 * VideoPreview component
 *
 * Shows a looping 5-second preview video returned by /generate-preview.
 * Displays BPM info and a "Generate Full Batch" call-to-action.
 */

import React, { useRef, useState } from "react";
import type { UploadResult } from "./UploadForm";
import { generatePreview, absoluteUrl } from "../lib/api";
import type { PreviewResponse } from "../lib/api";

interface Props {
  uploadResult: UploadResult;
  onGenerateBatch: () => void;
}

export default function VideoPreview({ uploadResult, onGenerateBatch }: Props) {
  const [loading, setLoading] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleGeneratePreview = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await generatePreview({
        music_id: uploadResult.musicId,
        clips_id: uploadResult.clipsId,
        caption_style: uploadResult.captionStyle,
        preview_duration: uploadResult.previewDuration,
      });
      setPreviewData(result);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Preview generation failed.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {/* Info strip */}
      <div
        className="card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <p
            className="text-sm text-secondary"
            style={{ marginBottom: "0.25rem" }}
          >
            Upload complete
          </p>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <span className="badge badge-purple">🎵 Music ready</span>
            <span className="badge badge-cyan">🎬 Clips ready</span>
            <span className="badge badge-orange">
              💬{" "}
              {uploadResult.captionStyle === "bold_center"
                ? "Bold Center"
                : uploadResult.captionStyle === "karaoke"
                  ? "Karaoke"
                  : "Minimal Clean"}
            </span>
          </div>
        </div>

        <button
          className="btn btn-primary"
          onClick={handleGeneratePreview}
          disabled={loading}
        >
          {loading ? (
            <>
              <div
                className="spinner"
                style={{ width: 14, height: 14, borderWidth: 2 }}
              />
              Rendering…
            </>
          ) : (
            "▶  Generate Preview"
          )}
        </button>
      </div>

      {/* Error */}
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

      {/* Preview player */}
      {previewData && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "1.25rem",
          }}
        >
          {/* BPM badge */}
          <div
            style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}
          >
            <span className="badge badge-green">
              🥁 {previewData.bpm} BPM detected
            </span>
            <span className="badge badge-purple">
              ⏱ {uploadResult.previewDuration}s preview
            </span>
          </div>

          {/* Vertical video shell */}
          <div
            style={{
              position: "relative",
              width: "220px",
              borderRadius: "18px",
              overflow: "hidden",
              border: "2px solid var(--accent-purple)",
              boxShadow: "var(--shadow-glow-purple)",
            }}
          >
            <video
              ref={videoRef}
              src={absoluteUrl(previewData.preview_url)}
              autoPlay
              loop
              muted
              playsInline
              style={{ width: "100%", display: "block" }}
            />
            {/* Overlay label */}
            <div
              style={{
                position: "absolute",
                top: "0.5rem",
                left: "0.5rem",
                background: "rgba(0,0,0,0.65)",
                borderRadius: "6px",
                padding: "0.2rem 0.5rem",
                fontSize: "0.65rem",
                fontWeight: 700,
                color: "#fff",
                backdropFilter: "blur(4px)",
              }}
            >
              PREVIEW · 360×640
            </div>
          </div>

          {/* CTA */}
          <div
            style={{
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
              alignItems: "center",
            }}
          >
            <p className="text-sm text-secondary">
              Happy with the beat sync? Generate all three caption style
              variants at full 1080×1920.
            </p>
            <button className="btn btn-accent btn-lg" onClick={onGenerateBatch}>
              🚀 Generate Full Batch
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "1rem",
            padding: "2rem",
          }}
        >
          <div
            className="spinner"
            style={{ width: 36, height: 36, borderWidth: 4 }}
          />
          <p className="text-sm text-secondary pulse">
            Detecting beats and assembling preview…
          </p>
          <p className="text-xs text-muted">This takes 10–30 seconds.</p>
        </div>
      )}
    </div>
  );
}
