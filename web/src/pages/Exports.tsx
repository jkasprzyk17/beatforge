/**
 * Exports — history of all render jobs with download links.
 */

import React, { useEffect, useState, useCallback, useRef } from "react";
import { getAllJobs, deleteJob, absoluteUrl } from "../lib/api";
import type { JobMetadata, JobOutput } from "../lib/api";

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const fmtDur = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const statusColor = (s: string) =>
  s === "done"
    ? "var(--green)"
    : s === "error"
      ? "var(--red)"
      : "var(--orange)";

const statusLabel = (s: string) =>
  s === "done" ? "✅ gotowe" : s === "error" ? "❌ błąd" : "⏳ " + s;

export default function Exports() {
  const [jobs, setJobs] = useState<JobMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getAllJobs();
      setJobs(data);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Poll while any job is still processing
    const id = setInterval(async () => {
      const data = await getAllJobs().catch(() => null);
      if (!data) return;
      setJobs(data);
      if (!data.some((j) => j.status === "queued" || j.status === "processing")) {
        clearInterval(id);
      }
    }, 3000);
    return () => clearInterval(id);
  }, [load]);

  const doneCount = jobs.filter((j) => j.status === "done").length;

  return (
    <div className="page-inner">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Eksporty</h1>
          <p className="page-sub">Gotowe filmy wygenerowane przez BeatForge AI</p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load}>
          ↻ Odśwież
        </button>
      </div>

      {error && (
        <div
          style={{
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "var(--radius)",
            color: "var(--red)",
            fontSize: "0.85rem",
            padding: "0.75rem 1rem",
            marginBottom: "1rem",
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {loading ? (
        <div className="empty">
          <p className="empty-sub pulse">Ładuję historię…</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">🎬</div>
          <p className="empty-title">Brak eksportów</p>
          <p className="empty-sub">
            Wygeneruj pierwszy film w zakładce Studio
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {/* Summary pill */}
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
              marginBottom: "0.25rem",
            }}
          >
            <span className="badge badge-green">{doneCount} gotowych</span>
            {jobs.filter((j) => j.status === "processing" || j.status === "queued").length > 0 && (
              <span className="badge" style={{ background: "rgba(249,115,22,.15)", color: "var(--orange)" }}>
                {jobs.filter((j) => j.status === "processing" || j.status === "queued").length} w toku
              </span>
            )}
            {jobs.filter((j) => j.status === "error").length > 0 && (
              <span className="badge" style={{ background: "rgba(239,68,68,.12)", color: "var(--red)" }}>
                {jobs.filter((j) => j.status === "error").length} błędów
              </span>
            )}
          </div>

          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onDelete={() => setJobs((p) => p.filter((j) => j.id !== job.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function JobCard({ job, onDelete }: { job: JobMetadata; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(job.status === "done");
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Usunąć ten job z historii?")) return;
    setDeleting(true);
    try {
      await deleteJob(job.id);
      onDelete();
    } catch {
      setDeleting(false);
    }
  };

  return (
    <div className="card card-p">
      {/* Card header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setExpanded((p) => !p)}
      >
        {/* Thumbnail or placeholder */}
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: "var(--radius)",
            overflow: "hidden",
            background: "var(--bg-4)",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.4rem",
          }}
        >
          {job.outputs[0]?.thumb_url ? (
            <img
              src={absoluteUrl(job.outputs[0].thumb_url)}
              alt="thumb"
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            "🎬"
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: "0.85rem" }}>
              Job {job.id.slice(0, 8)}
            </span>
            <span
              className="badge"
              style={{
                background: `${statusColor(job.status)}18`,
                color: statusColor(job.status),
                fontSize: "0.65rem",
              }}
            >
              {statusLabel(job.status)}
            </span>
            {job.outputs.length > 0 && (
              <span className="badge" style={{ fontSize: "0.65rem" }}>
                {job.outputs.length} wariant{job.outputs.length > 1 ? "y" : ""}
              </span>
            )}
          </div>
          <p style={{ fontSize: "0.75rem", color: "var(--text-2)", marginTop: "0.15rem" }}>
            {fmtTime(job.created_at)}
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
          <span style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>
            {expanded ? "▲" : "▼"}
          </span>
          <button
            className="btn btn-sm btn-danger"
            style={{ padding: "0.25rem 0.5rem", fontSize: "0.7rem" }}
            disabled={deleting}
            onClick={handleDelete}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Progress loader for active jobs */}
      {(job.status === "queued" || job.status === "processing") && (
        <RenderProgress job={job} />
      )}

      {/* Error */}
      {job.status === "error" && (
        <p style={{ color: "var(--red)", fontSize: "0.8rem", marginTop: "0.6rem" }}>
          {job.error ?? "Nieznany błąd."}
        </p>
      )}

      {/* Outputs */}
      {expanded && job.status === "done" && job.outputs.length > 0 && (
        <div style={{ marginTop: "0.85rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {job.outputs.map((o: JobOutput, i: number) => (
            <OutputRow key={i} output={o} jobId={job.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function RenderProgress({ job }: { job: JobMetadata }) {
  const pct = job.progress ?? (job.status === "processing" ? 15 : 3);
  const stepLabel = job.step ?? (job.status === "queued" ? "Czekam na worker…" : "Przetwarzam…");
  const [elapsed, setElapsed] = useState(Math.floor((Date.now() - job.created_at) / 1000));
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - job.created_at) / 1000)), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [job.created_at]);

  const fmtElapsed = (s: number) => s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;

  return (
    <div style={{ marginTop: "0.85rem" }}>
      {/* Bar */}
      <div style={{ position: "relative", height: 7, background: "var(--bg-4)", borderRadius: 99, overflow: "hidden", marginBottom: "0.5rem" }}>
        <div style={{
          position: "absolute", left: 0, top: 0, height: "100%",
          width: `${pct}%`,
          background: "linear-gradient(90deg, var(--purple), var(--cyan))",
          borderRadius: 99,
          transition: "width 0.6s ease",
        }} />
        <div style={{
          position: "absolute", top: 0, left: 0, height: "100%", width: "100%",
          background: "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%)",
          animation: "shimmer 1.8s infinite",
        }} />
      </div>

      {/* Step + elapsed + pct */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.45rem" }}>
        <span style={{ fontSize: "0.73rem", color: "var(--text-2)" }}>
          {stepLabel}
          {job.total_variants && job.total_variants > 1 && job.done_variants != null && (
            <span style={{ color: "var(--text-3)", marginLeft: "0.35rem" }}>
              ({job.done_variants}/{job.total_variants})
            </span>
          )}
        </span>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.7rem", color: "var(--text-3)" }}>⏱ {fmtElapsed(elapsed)}</span>
          <span style={{ fontSize: "0.7rem", color: "var(--purple)", fontWeight: 700 }}>{pct}%</span>
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
          <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
            {phases.map((phase) => {
              const done = pct >= phase.to;
              const active = pct >= phase.from && pct < phase.to;
              return (
                <span key={phase.key} style={{
                  fontSize: "0.63rem",
                  padding: "0.12rem 0.45rem",
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
  );
}

function OutputRow({ output: o, jobId }: { output: JobOutput; jobId: string }) {
  const [thumbErr, setThumbErr] = useState(false);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.65rem",
        padding: "0.6rem 0.75rem",
        background: "var(--bg-3)",
        borderRadius: "var(--radius)",
        border: "1px solid var(--border)",
        flexWrap: "wrap",
      }}
    >
      {/* Thumbnail */}
      {o.thumb_url && !thumbErr ? (
        <img
          src={absoluteUrl(o.thumb_url)}
          alt="thumb"
          onError={() => setThumbErr(true)}
          style={{
            width: 48,
            height: 48,
            objectFit: "cover",
            borderRadius: 6,
            flexShrink: 0,
          }}
        />
      ) : (
        <div
          style={{
            width: 48,
            height: 48,
            background: "var(--bg-4)",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.2rem",
            flexShrink: 0,
          }}
        >
          🎬
        </div>
      )}

      {/* Meta */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
          <span className="badge badge-green" style={{ fontSize: "0.6rem" }}>
            v{o.variant}
          </span>
          <span className="badge" style={{ fontSize: "0.6rem", textTransform: "uppercase" }}>
            {o.platform}
          </span>
          {o.style && (
            <span className="badge" style={{ fontSize: "0.6rem" }}>
              {o.style}
            </span>
          )}
        </div>
        {o.final_duration != null && (
          <p style={{ fontSize: "0.72rem", color: "var(--text-2)", marginTop: "0.15rem" }}>
            {fmtDur(o.final_duration)}
          </p>
        )}
      </div>

      {/* Download buttons */}
      <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
        <a
          href={absoluteUrl(o.video_url)}
          download={`beatforge_${jobId.slice(0, 8)}_v${o.variant}_${o.platform}.mp4`}
          className="btn btn-sm btn-primary"
          style={{ padding: "0.3rem 0.65rem", fontSize: "0.72rem" }}
        >
          ⬇ MP4
        </a>
        {(o.caption_url || o.srt_url) && (
          <a
            href={absoluteUrl((o.caption_url || o.srt_url)!)}
            download
            className="btn btn-sm btn-ghost"
            style={{ padding: "0.3rem 0.65rem", fontSize: "0.72rem" }}
          >
            ⬇ Napisy
          </a>
        )}
      </div>
    </div>
  );
}
