import { useState, useEffect } from "react";
import "./styles/global.css";
import { AppProvider, useApp } from "./context/AppContext";
import Library from "./pages/Library";
import TextHooks from "./pages/TextHooks";
import Studio from "./pages/Studio";
import Clips from "./pages/Clips";
import Exports from "./pages/Exports";
import { getAllJobs } from "./lib/api";

type Tab = "library" | "hooks" | "studio" | "clips" | "exports";

const NAV: {
  id: Tab;
  icon: string;
  label: string;
  badge?: (counts: Record<string, number>) => number;
}[] = [
  { id: "studio",  icon: "🎬", label: "Studio",     badge: () => 0 },
  { id: "library", icon: "🎵", label: "Pliki MP3",  badge: (c) => c.tracks },
  { id: "hooks",   icon: "🪝", label: "Text Hooks", badge: (c) => c.hooks },
  { id: "clips",   icon: "📁", label: "Pliki MP4",  badge: (c) => c.collections },
  { id: "exports", icon: "🎞️", label: "Eksporty",   badge: (c) => c.exports },
];

function Shell() {
  const [tab, setTab] = useState<Tab>("studio");
  const { tracks, hooks, collections } = useApp();
  const [doneExports, setDoneExports] = useState(0);

  // Refresh the exports badge on mount and whenever any job is still active
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;

    const refresh = () => {
      getAllJobs()
        .then((jobs) => {
          setDoneExports(jobs.filter((j) => j.status === "done").length);
          // Keep polling while jobs are in-flight; back off once all settled
          const active = jobs.some(
            (j) => j.status === "queued" || j.status === "processing",
          );
          clearInterval(timer);
          timer = setInterval(refresh, active ? 4000 : 30000);
        })
        .catch(() => {});
    };

    refresh();
    return () => clearInterval(timer);
  }, []);

  const counts = {
    tracks:      tracks.length,
    hooks:       hooks.length,
    collections: collections.length,
    exports:     doneExports,
  };

  return (
    <div className="app-shell">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">🎬</div>
          <span className="sidebar-logo-text">BeatForge AI</span>
        </div>

        <nav className="nav-section">
          <p className="nav-label">Workspace</p>
          {NAV.map((item) => {
            const count = item.badge?.(counts) ?? 0;
            return (
              <button
                key={item.id}
                className={`nav-item ${tab === item.id ? "active" : ""}`}
                onClick={() => setTab(item.id)}
              >
                <span className="nav-item-icon">{item.icon}</span>
                {item.label}
                {count > 0 && <span className="nav-badge">{count}</span>}
              </button>
            );
          })}
        </nav>

        {/* Studio quick-status */}
        <div style={{ marginTop: "auto", padding: "0 0.75rem" }}>
          <div
            style={{
              background: "var(--bg-3)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "0.85rem",
              fontSize: "0.75rem",
              color: "var(--text-2)",
            }}
          >
            <p
              style={{
                fontWeight: 700,
                color: "var(--text)",
                marginBottom: "0.5rem",
                fontSize: "0.78rem",
              }}
            >
              Studio status
            </p>
            <StatusLine label="Track" ok={counts.tracks > 0} />
            <StatusLine label="Kolekcja" ok={counts.collections > 0} />
            <StatusLine label="Hook" ok={counts.hooks > 0} />
          </div>
        </div>
      </aside>

      {/* ── Page ── */}
      <main className="page-content">
        {tab === "library" && <Library onGoToStudio={() => setTab("studio")} />}
        {tab === "hooks" && <TextHooks />}
        {tab === "studio" && (
          <Studio
            onGoToLibrary={() => setTab("library")}
            onGoToClips={() => setTab("clips")}
          />
        )}
        {tab === "clips" && <Clips onGoToStudio={() => setTab("studio")} />}
        {tab === "exports" && <Exports />}
      </main>
    </div>
  );
}

function StatusLine({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
        marginBottom: "0.3rem",
      }}
    >
      <span
        style={{
          color: ok ? "var(--green)" : "var(--text-3)",
          fontSize: "0.65rem",
        }}
      >
        {ok ? "●" : "○"}
      </span>
      <span style={{ color: ok ? "var(--text-2)" : "var(--text-3)" }}>
        {label}
      </span>
      {ok && (
        <span
          style={{ marginLeft: "auto", color: "var(--green)", fontWeight: 700 }}
        >
          ✓
        </span>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
