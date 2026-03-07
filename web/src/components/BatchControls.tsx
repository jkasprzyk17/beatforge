/**
 * BatchControls component
 *
 * Triggers the /generate-batch endpoint and polls /api/jobs/{id}
 * every 3 seconds until the job is done or errored.
 * Once done, shows a download grid for each style + variant output.
 */

import { useEffect, useRef, useState } from "react";
import type { UploadResult } from "./UploadForm";
import { generateBatch, getJob, absoluteUrl } from "../lib/api";
import type { JobMetadata, JobOutput } from "../lib/api";

interface Props {
  uploadResult: UploadResult;
}

const ALL_STYLES = ["bold_center", "karaoke", "minimal_clean"] as const;
const STYLE_LABELS: Record<string, string> = {
  bold_center: "Bold Center",
  karaoke: "Karaoke",
  minimal_clean: "Minimal Clean",
};
const STYLE_ICONS: Record<string, string> = {
  bold_center: "⬛",
  karaoke: "🎤",
  minimal_clean: "✨",
};

export default function BatchControls({ uploadResult }: Props) {
  const [batchCount, setBatchCount] = useState(1);
  const [selectedStyles, setSelectedStyles] = useState<string[]>([
    ...ALL_STYLES,
  ]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- Polling ----

  useEffect(() => {
    if (!jobId) return;

    const poll = async () => {
      try {
        const data = await getJob(jobId);
        setJob(data);
        if (data.status === "done" || data.status === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        // Silently retry
      }
    };

    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [jobId]);

  // ---- Submit batch ----

  const handleStart = async () => {
    if (selectedStyles.length === 0) return;
    setError(null);
    setSubmitting(true);
    setJob(null);

    try {
      const res = await generateBatch({
        music_id: uploadResult.musicId,
        clips_id: uploadResult.clipsId,
        caption_styles: selectedStyles,
        video_duration: 20,
        batch_count: batchCount,
      });
      setJobId(res.job_id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to start batch.");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleStyle = (style: string) =>
    setSelectedStyles((prev) =>
      prev.includes(style) ? prev.filter((s) => s !== style) : [...prev, style],
    );

  const statusColor = (s: string) => {
    if (s === "done") return "var(--accent-green)";
    if (s === "error") return "var(--accent-red)";
    return "var(--accent-orange)";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {/* ---- Configuration ---- */}
      {!jobId && (
        <>
          <div className="card">
            <h2
              style={{
                marginBottom: "1rem",
                fontSize: "1rem",
                fontWeight: 700,
              }}
            >
              🎨 Caption Styles to Generate
            </h2>
            <div className="grid-3">
              {ALL_STYLES.map((s) => {
                const on = selectedStyles.includes(s);
                return (
                  <button
                    key={s}
                    onClick={() => toggleStyle(s)}
                    style={{
                      background: on
                        ? "rgba(124,58,237,0.15)"
                        : "var(--bg-base)",
                      border: `2px solid ${on ? "var(--accent-purple)" : "var(--border)"}`,
                      borderRadius: "var(--radius-md)",
                      padding: "1rem",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "all var(--transition)",
                    }}
                  >
                    <div style={{ fontSize: "1.4rem", marginBottom: "0.4rem" }}>
                      {STYLE_ICONS[s]}
                    </div>
                    <p
                      style={{
                        fontWeight: 700,
                        fontSize: "0.88rem",
                        color: on
                          ? "var(--accent-purple-light)"
                          : "var(--text-primary)",
                      }}
                    >
                      {STYLE_LABELS[s]}
                    </p>
                    {on && (
                      <span
                        className="badge badge-purple"
                        style={{ marginTop: "0.4rem" }}
                      >
                        ✓ Selected
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="card">
            <h2
              style={{
                marginBottom: "1rem",
                fontSize: "1rem",
                fontWeight: 700,
              }}
            >
              🔁 Variations per Style
            </h2>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={batchCount}
                onChange={(e) => setBatchCount(Number(e.target.value))}
                style={{ flex: 1, accentColor: "var(--accent-orange)" }}
              />
              <span
                style={{
                  minWidth: "3rem",
                  fontWeight: 700,
                  color: "var(--accent-orange-light)",
                  fontSize: "1.1rem",
                }}
              >
                ×{batchCount}
              </span>
            </div>
            <p className="text-xs text-muted mt-2">
              Each variation uses a different random clip order.
            </p>
          </div>

          <div
            className="card"
            style={{
              background: "rgba(249,115,22,0.05)",
              borderColor: "rgba(249,115,22,0.3)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <p className="font-semibold">
                  {selectedStyles.length * batchCount} video
                  {selectedStyles.length * batchCount !== 1 ? "s" : ""} will be
                  generated
                </p>
                <p className="text-xs text-muted mt-2">
                  Full 1080×1920 · 20 s · Whisper transcription · Beat-synced
                  cuts
                </p>
              </div>
              <button
                className="btn btn-accent btn-lg"
                onClick={handleStart}
                disabled={submitting || selectedStyles.length === 0}
              >
                {submitting ? (
                  <>
                    <div
                      className="spinner"
                      style={{ width: 14, height: 14, borderWidth: 2 }}
                    />
                    Queuing…
                  </>
                ) : (
                  "🚀 Start Batch"
                )}
              </button>
            </div>
          </div>
        </>
      )}

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

      {/* ---- Job status ---- */}
      {job && (
        <div className="card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "1rem",
            }}
          >
            <h2 style={{ fontSize: "1rem", fontWeight: 700 }}>Job Status</h2>
            <span
              className="badge"
              style={{
                background: `${statusColor(job.status)}22`,
                color: statusColor(job.status),
              }}
            >
              {job.status === "done" && "✅ "}
              {job.status === "error" && "❌ "}
              {["queued", "processing"].includes(job.status) && "⏳ "}
              {job.status.toUpperCase()}
            </span>
          </div>

          {job.bpm && (
            <p
              className="text-sm text-secondary"
              style={{ marginBottom: "0.75rem" }}
            >
              🥁 Detected BPM: <strong>{job.bpm.toFixed(1)}</strong>
            </p>
          )}

          {["queued", "processing"].includes(job.status) && (
            <div>
              <div className="progress-bar">
                <div
                  className="progress-bar__fill"
                  style={{ width: job.status === "processing" ? "60%" : "10%" }}
                />
              </div>
              <p className="text-xs text-muted mt-2 pulse">
                {job.status === "queued"
                  ? "Job is queued — will begin shortly…"
                  : "Assembling video, transcribing audio, burning captions…"}
              </p>
            </div>
          )}

          {job.status === "error" && (
            <p style={{ color: "var(--accent-red)", fontSize: "0.88rem" }}>
              {job.error ?? "An unknown error occurred."}
            </p>
          )}

          {/* ---- Outputs grid ---- */}
          {job.status === "done" && job.outputs && job.outputs.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: "1rem",
                marginTop: "1rem",
              }}
            >
              {job.outputs.map((out: JobOutput, i: number) => (
                <OutputCard key={i} output={out} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- Start over ---- */}
      {jobId && (
        <button
          className="btn btn-ghost"
          onClick={() => {
            setJobId(null);
            setJob(null);
            setError(null);
          }}
        >
          ← New Batch
        </button>
      )}
    </div>
  );
}

function OutputCard({ output }: { output: JobOutput }) {
  return (
    <div
      style={{
        background: "var(--bg-base)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Mini video */}
      <div
        style={{
          background: "#000",
          aspectRatio: "9/16",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        <video
          src={absoluteUrl(output.video_url)}
          muted
          loop
          playsInline
          onMouseEnter={(e) => (e.currentTarget as HTMLVideoElement).play()}
          onMouseLeave={(e) => (e.currentTarget as HTMLVideoElement).pause()}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <div
          style={{
            position: "absolute",
            top: "0.4rem",
            left: "0.4rem",
            background: "rgba(0,0,0,0.7)",
            borderRadius: "4px",
            padding: "0.15rem 0.4rem",
            fontSize: "0.6rem",
            fontWeight: 700,
            color: "#fff",
          }}
        >
          {STYLE_ICONS[output.style]} {STYLE_LABELS[output.style]}
        </div>
        <div
          style={{
            position: "absolute",
            bottom: "0.4rem",
            right: "0.4rem",
            background: "rgba(0,0,0,0.7)",
            borderRadius: "4px",
            padding: "0.15rem 0.4rem",
            fontSize: "0.6rem",
            color: "var(--text-secondary)",
          }}
        >
          v{output.variant}
        </div>
      </div>

      {/* Download buttons */}
      <div style={{ padding: "0.75rem", display: "flex", gap: "0.5rem" }}>
        <a
          href={absoluteUrl(output.video_url)}
          download
          className="btn btn-primary"
          style={{
            flex: 1,
            justifyContent: "center",
            fontSize: "0.78rem",
            padding: "0.5rem",
          }}
        >
          ⬇ MP4
        </a>
        <a
          href={absoluteUrl(output.srt_url ?? output.caption_url)}
          download
          className="btn btn-ghost"
          style={{
            flex: 1,
            justifyContent: "center",
            fontSize: "0.78rem",
            padding: "0.5rem",
          }}
        >
          📝 SRT
        </a>
      </div>
    </div>
  );
}
