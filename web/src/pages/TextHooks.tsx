/**
 * TextHooks — manage text hooks grouped by MoodFolder (same moods as clip Collections).
 * This means hooks and clips share the same vibe taxonomy → Studio can match them.
 */

import React, { useState, useRef } from "react";
import { useApp } from "../context/AppContext";
import type { TextHook, MoodFolder } from "../context/AppContext";
import {
  createHook as apiCreateHook,
  removeHook as apiRemoveHook,
  importHooks as apiImportHooks,
} from "../lib/api";

const POPULAR_EMOJIS = [
  "🔥",
  "💥",
  "⚡",
  "🎯",
  "💀",
  "🤯",
  "😱",
  "👀",
  "💸",
  "🏆",
  "🎬",
  "📱",
  "💪",
  "🧠",
  "✨",
  "🪝",
  "📣",
  "❓",
  "📖",
  "💡",
  "🎵",
  "🎤",
  "🎸",
  "🥁",
  "🎹",
  "🎧",
  "🚀",
  "💫",
  "⭐",
  "🌟",
];

// Examples keyed by mood id
const MOOD_EXAMPLES: Record<string, string[]> = {
  "high-energy": [
    "To zmieni twoje życie w 24h",
    "Nie możesz tego przegapić",
    "Zrobiłem to przez 30 dni i oto co się stało",
  ],
  hype: [
    "POV: właśnie odkryłeś…",
    "Zostań do końca — mam dla ciebie coś szalonego",
    "Nie przewiniesz tego dalej…",
  ],
  dark: [
    "Nikt ci o tym nie powie, ale…",
    "To jest mroczna strona tego tematu",
    "Wszystko zmieniło się gdy przestałem to robić",
  ],
  sad: [
    "To uczucie gdy wszystko idzie nie tak…",
    "Czasem cisza mówi więcej niż słowa",
    "Nikt nie widzi ile niosę",
  ],
  chill: [
    "Spokojny wieczór, dobra muzyka",
    "Nie musisz nic udowadniać",
    "Tu i teraz to wystarczy",
  ],
  motivational: [
    "Jeden krok dziennie przez rok — oto efekt",
    "Zacząłem od zera, dzisiaj mam wszystko",
    "Nie ma skrótu, jest tylko droga",
  ],
};

const DEFAULT_EXAMPLES = [
  "Nikt ci o tym nie powie, ale…",
  "Zrobiłem to przez 30 dni i oto co się stało",
  "Nie przewiniesz tego dalej…",
  "To jest najgorsza rada jaką możesz dostać",
  "Zostań do końca, bo mam coś dla ciebie",
  "Wszystko zmieniło się gdy przestałem to robić",
];

let _hookId = 1;
const uid = () => `hook_${Date.now()}_${_hookId++}`;

/** Parse CSV line; supports comma or semicolon, quoted fields. */
function parseCSVLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i += 1;
      let cell = "";
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\") i += 1;
        cell += line[i++];
      }
      if (line[i] === '"') i += 1;
      out.push(cell.trim());
    } else {
      const sep = line.slice(i).match(/^([^,;]*)([,;]|$)/);
      if (!sep) break;
      out.push((sep[1] ?? "").trim());
      i += (sep[1]?.length ?? 0) + (sep[2] === "," || sep[2] === ";" ? 1 : 0);
    }
  }
  return out;
}

// Convert hex/css color → rgba for background tint
function moodBg(color: string, alpha = 0.15) {
  return color.startsWith("#")
    ? `${color}${Math.round(alpha * 255)
        .toString(16)
        .padStart(2, "0")}`
    : `rgba(0,0,0,${alpha})`;
}

export default function TextHooks() {
  const {
    hooks,
    addHook,
    addHooks,
    removeHook,
    setStudioHook,
    studioHookId,
    moods,
    addMood,
    removeMood,
  } = useApp();

  const [text, setText] = useState("");
  const [selMood, setSelMood] = useState(moods[0]?.id ?? "high-energy");
  const [filter, setFilter] = useState<string>("all");

  // New-mood modal
  const [showNewMood, setShowNewMood] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newEmoji, setNewEmoji] = useState("🔥");
  const [newColor, setNewColor] = useState("#8b5cf6");
  const [emojiMode, setEmojiMode] = useState<"pick" | "type">("pick");
  const [customEmoji, setCustomEmoji] = useState("");
  const [importStatus, setImportStatus] = useState<{
    loading?: boolean;
    done?: number;
    error?: string;
  } | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    const t = text.trim();
    if (!t) return;
    const hookId = uid();
    addHook({ id: hookId, text: t, category: selMood, createdAt: new Date() });
    setText("");
    apiCreateHook({ id: hookId, text: t, mood_id: selMood }).catch((err) =>
      console.warn("[hooks] persist failed:", err),
    );
  };

  const handleAddMood = () => {
    const label = newLabel.trim();
    const emoji = emojiMode === "type" ? customEmoji.trim() || "💡" : newEmoji;
    if (!label) return;
    addMood({ id: uid(), label, emoji, color: newColor, isDefault: false });
    setNewLabel("");
    setNewEmoji("🔥");
    setNewColor("#8b5cf6");
    setCustomEmoji("");
    setEmojiMode("pick");
    setShowNewMood(false);
  };

  const addExample = (ex: string) => {
    const hookId = uid();
    addHook({ id: hookId, text: ex, category: selMood, createdAt: new Date() });
    apiCreateHook({ id: hookId, text: ex, mood_id: selMood }).catch((err) =>
      console.warn("[hooks] persist example failed:", err),
    );
  };

  const resolveMoodId = (cell: string): string => {
    const s = (cell ?? "").trim().toLowerCase();
    if (!s) return selMood;
    const m = moods.find(
      (x) => x.id.toLowerCase() === s || x.label.toLowerCase() === s,
    );
    return m?.id ?? selMood;
  };

  const handleImportCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportStatus({ loading: true });
    try {
      const raw = await file.text();
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const payload: Array<{ text: string; mood_id: string }> = [];
      for (const line of lines) {
        const cells = parseCSVLine(line);
        const text = (cells[0] ?? "").trim();
        if (!text) continue;
        const moodId = cells[1] !== undefined ? resolveMoodId(cells[1]) : selMood;
        payload.push({ text, mood_id: moodId });
      }
      if (payload.length === 0) {
        setImportStatus({ error: "Brak poprawnych wierszy (tekst w pierwszej kolumnie)." });
        return;
      }
      const { created } = await apiImportHooks(payload);
      const asTextHooks = created.map((r) => ({
        id: r.id,
        text: r.text,
        category: r.moodId ?? selMood,
        createdAt: new Date(r.createdAt),
      }));
      addHooks(asTextHooks);
      setImportStatus({ done: created.length });
    } catch (err) {
      setImportStatus({
        error: err instanceof Error ? err.message : "Import nie powiódł się.",
      });
    }
  };

  const filtered =
    filter === "all" ? hooks : hooks.filter((h) => h.category === filter);
  const countFor = (id: string) =>
    hooks.filter((h) => h.category === id).length;

  const activeMood = moods.find((m) => m.id === filter);
  const examples =
    filter !== "all" && MOOD_EXAMPLES[filter]
      ? MOOD_EXAMPLES[filter]
      : DEFAULT_EXAMPLES;

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">🪝 Text Hooks</h1>
        <p className="page-subtitle">
          Tytuły i haczyki dobrane do vibu — te same foldery co klipy MP4
        </p>
      </div>

      <div className="page-body">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 320px",
            gap: "1.5rem",
            alignItems: "start",
          }}
        >
          {/* ── LEFT: hook list ── */}
          <div>
            {/* Mood filter bar */}
            <div
              style={{
                display: "flex",
                gap: "0.4rem",
                marginBottom: "1rem",
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <button
                className="btn btn-sm"
                onClick={() => setFilter("all")}
                style={{
                  background:
                    filter === "all" ? "var(--purple)" : "var(--bg-3)",
                  color: filter === "all" ? "#fff" : "var(--text-2)",
                  border: "1px solid var(--border)",
                }}
              >
                Wszystkie ({hooks.length})
              </button>

              {moods.map((mood) => {
                const count = countFor(mood.id);
                const active = filter === mood.id;
                return (
                  <button
                    key={mood.id}
                    onClick={() => setFilter(mood.id)}
                    className="btn btn-sm"
                    style={{
                      background: active
                        ? moodBg(mood.color, 0.2)
                        : "var(--bg-3)",
                      color: active ? mood.color : "var(--text-2)",
                      border: `1px solid ${active ? mood.color : "var(--border)"}`,
                    }}
                  >
                    {mood.emoji} {mood.label}
                    {count > 0 && (
                      <span
                        style={{
                          marginLeft: "0.3rem",
                          fontSize: "0.65rem",
                          fontWeight: 800,
                          background: "rgba(255,255,255,0.1)",
                          borderRadius: "99px",
                          padding: "0 0.3rem",
                        }}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}

              <button
                className="btn btn-sm"
                onClick={() => setShowNewMood(true)}
                style={{
                  border: "1px dashed var(--border)",
                  color: "var(--text-3)",
                  background: "transparent",
                }}
              >
                + Mood
              </button>
            </div>

            {/* Mood info banner */}
            {activeMood && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                  padding: "0.6rem 0.85rem",
                  marginBottom: "0.85rem",
                  background: moodBg(activeMood.color, 0.12),
                  border: `1px solid ${moodBg(activeMood.color, 0.4)}`,
                  borderRadius: "var(--radius)",
                }}
              >
                <span style={{ fontSize: "1.2rem" }}>{activeMood.emoji}</span>
                <div>
                  <p
                    style={{
                      fontWeight: 700,
                      fontSize: "0.82rem",
                      color: activeMood.color,
                    }}
                  >
                    {activeMood.label}
                  </p>
                  <p className="text-xs text-3">
                    Ten folder pasuje do kolekcji klipów z tego samego vibe'u
                  </p>
                </div>
              </div>
            )}

            {/* Hook cards */}
            {filtered.length === 0 ? (
              <div className="empty" style={{ padding: "2.5rem" }}>
                <div className="empty-icon">🪝</div>
                <p className="empty-title">Brak hooków</p>
                <p className="empty-sub">
                  Dodaj pierwszy hook albo użyj przykładów →
                </p>
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                }}
              >
                {filtered.map((h) => {
                  const mood = moods.find((m) => m.id === h.category);
                  return (
                    <HookCard
                      key={h.id}
                      hook={h}
                      mood={mood}
                      active={studioHookId === h.id}
                      onUse={() => setStudioHook(h.id)}
                      onRemove={() => {
                        removeHook(h.id);
                        apiRemoveHook(h.id).catch((err) =>
                          console.warn("[hooks] delete failed:", err),
                        );
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* ── RIGHT: panels ── */}
          <div
            style={{
              position: "sticky",
              top: "1.5rem",
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
            }}
          >
            {/* Add hook */}
            <div className="card card-p">
              <p
                style={{
                  fontWeight: 700,
                  fontSize: "0.9rem",
                  marginBottom: "1rem",
                }}
              >
                Dodaj nowy hook
              </p>

              <div className="field" style={{ marginBottom: "0.75rem" }}>
                <label className="label">Tekst hooka</label>
                <textarea
                  className="textarea"
                  placeholder="Np. Nikt ci o tym nie powie, ale…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.metaKey) handleAdd();
                  }}
                  style={{ minHeight: 78 }}
                />
              </div>

              <div className="field" style={{ marginBottom: "1rem" }}>
                <label className="label">Mood / Folder</label>
                <div
                  style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}
                >
                  {moods.map((mood) => {
                    const active = selMood === mood.id;
                    return (
                      <button
                        key={mood.id}
                        onClick={() => setSelMood(mood.id)}
                        className="btn btn-sm"
                        style={{
                          background: active
                            ? moodBg(mood.color, 0.2)
                            : "var(--bg-4)",
                          color: active ? mood.color : "var(--text-2)",
                          border: `1px solid ${active ? mood.color : "var(--border)"}`,
                          fontSize: "0.72rem",
                        }}
                      >
                        {mood.emoji} {mood.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                className="btn btn-primary w-full"
                onClick={handleAdd}
                disabled={!text.trim()}
                style={{ justifyContent: "center" }}
              >
                + Dodaj hook
              </button>
              <p
                style={{
                  fontSize: "0.68rem",
                  color: "var(--text-3)",
                  textAlign: "center",
                  marginTop: "0.4rem",
                }}
              >
                lub ⌘+Enter
              </p>
            </div>

            {/* Import z CSV / Excel */}
            <div className="card card-p">
              <p
                style={{
                  fontWeight: 700,
                  fontSize: "0.9rem",
                  marginBottom: "0.5rem",
                }}
              >
                Import z CSV / Excel
              </p>
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-3)",
                  marginBottom: "0.75rem",
                  lineHeight: 1.4,
                }}
              >
                Jedna kolumna = tekst hooka. Opcjonalnie druga kolumna = mood (id lub nazwa). Rozdzielacz: przecinek lub średnik. Wszystkie bez moodu trafią do wybranego moodu obok.
              </p>
              <input
                ref={importFileInputRef}
                type="file"
                accept=".csv,.txt,text/csv,application/csv"
                onChange={handleImportCSV}
                style={{ display: "none" }}
              />
              <button
                type="button"
                className="btn w-full"
                disabled={!!importStatus?.loading}
                onClick={() => importFileInputRef.current?.click()}
                style={{
                  justifyContent: "center",
                  border: "1px dashed var(--border)",
                  background: "var(--bg-3)",
                }}
              >
                {importStatus?.loading ? "Importuję…" : "📂 Wybierz plik CSV"}
              </button>
              {importStatus?.done != null && (
                <p style={{ fontSize: "0.8rem", color: "var(--green)", marginTop: "0.5rem" }}>
                  Zaimportowano {importStatus.done} hooków.
                </p>
              )}
              {importStatus?.error && (
                <p style={{ fontSize: "0.8rem", color: "var(--red)", marginTop: "0.5rem" }}>
                  {importStatus.error}
                </p>
              )}
            </div>

            {/* Mood manager */}
            <div className="card card-p">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "0.75rem",
                }}
              >
                <p
                  style={{
                    fontWeight: 700,
                    fontSize: "0.82rem",
                    color: "var(--text-2)",
                  }}
                >
                  Mood foldery ({moods.length})
                </p>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => setShowNewMood(true)}
                  style={{ fontSize: "0.72rem", padding: "0.3rem 0.65rem" }}
                >
                  + Nowy
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.3rem",
                }}
              >
                {moods.map((mood) => (
                  <div
                    key={mood.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      padding: "0.45rem 0.6rem",
                      background: "var(--bg-3)",
                      borderRadius: "var(--radius)",
                      border: `1px solid ${moodBg(mood.color, 0.3)}`,
                    }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        flexShrink: 0,
                        background: mood.color,
                      }}
                    />
                    <span style={{ fontSize: "0.85rem" }}>{mood.emoji}</span>
                    <span
                      style={{ fontSize: "0.8rem", fontWeight: 600, flex: 1 }}
                    >
                      {mood.label}
                    </span>
                    <span
                      style={{
                        background: moodBg(mood.color, 0.2),
                        color: mood.color,
                        padding: "0.1rem 0.4rem",
                        borderRadius: "99px",
                        fontSize: "0.62rem",
                        fontWeight: 700,
                      }}
                    >
                      {countFor(mood.id)}
                    </span>
                    {!mood.isDefault && (
                      <button
                        onClick={() => removeMood(mood.id)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--text-3)",
                          cursor: "pointer",
                          fontSize: "0.8rem",
                          lineHeight: 1,
                          padding: "0.1rem",
                          transition: "color var(--t)",
                        }}
                        onMouseEnter={(e) =>
                          ((e.currentTarget as HTMLElement).style.color =
                            "var(--red)")
                        }
                        onMouseLeave={(e) =>
                          ((e.currentTarget as HTMLElement).style.color =
                            "var(--text-3)")
                        }
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Examples */}
            <div className="card card-p">
              <p
                style={{
                  fontWeight: 700,
                  fontSize: "0.82rem",
                  marginBottom: "0.75rem",
                  color: "var(--text-2)",
                }}
              >
                💡 Przykłady
                {activeMood ? ` — ${activeMood.emoji} ${activeMood.label}` : ""}
              </p>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                }}
              >
                {examples.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => addExample(ex)}
                    style={{
                      background: "var(--bg-3)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius)",
                      padding: "0.5rem 0.7rem",
                      textAlign: "left",
                      fontSize: "0.77rem",
                      color: "var(--text-2)",
                      cursor: "pointer",
                      transition: "all var(--t)",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.borderColor =
                        "var(--purple)";
                      (e.currentTarget as HTMLElement).style.color =
                        "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.borderColor =
                        "var(--border)";
                      (e.currentTarget as HTMLElement).style.color =
                        "var(--text-2)";
                    }}
                  >
                    + {ex}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── New Mood Modal ── */}
      {showNewMood && (
        <Modal onClose={() => setShowNewMood(false)}>
          <p
            style={{
              fontWeight: 800,
              fontSize: "1rem",
              marginBottom: "1.25rem",
            }}
          >
            Nowy Mood Folder
          </p>

          <div className="field" style={{ marginBottom: "1rem" }}>
            <label className="label">Nazwa</label>
            <input
              className="input"
              placeholder="np. Sad Hours, Club Banger…"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddMood();
              }}
              autoFocus
            />
          </div>

          <div className="field" style={{ marginBottom: "1rem" }}>
            <label className="label">Emoji</label>
            <div
              style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}
            >
              {(["pick", "type"] as const).map((m) => (
                <button
                  key={m}
                  className="btn btn-sm"
                  onClick={() => setEmojiMode(m)}
                  style={{
                    background:
                      emojiMode === m ? "var(--purple)" : "var(--bg-4)",
                    color: emojiMode === m ? "#fff" : "var(--text-2)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {m === "pick" ? "Wybierz" : "Wpisz ręcznie"}
                </button>
              ))}
            </div>
            {emojiMode === "pick" ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
                {POPULAR_EMOJIS.map((e) => (
                  <button
                    key={e}
                    onClick={() => setNewEmoji(e)}
                    style={{
                      width: 36,
                      height: 36,
                      fontSize: "1.1rem",
                      background:
                        newEmoji === e ? "var(--purple-dim)" : "var(--bg-4)",
                      border: `1.5px solid ${newEmoji === e ? "var(--purple)" : "var(--border)"}`,
                      borderRadius: "var(--radius)",
                      cursor: "pointer",
                      transition: "all var(--t)",
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            ) : (
              <input
                className="input"
                placeholder="Wklej lub wpisz emoji, np. 🎯"
                value={customEmoji}
                onChange={(e) => setCustomEmoji(e.target.value)}
                style={{ fontSize: "1.2rem" }}
              />
            )}
          </div>

          <div className="field" style={{ marginBottom: "1.25rem" }}>
            <label className="label">Kolor</label>
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <input
                type="color"
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                style={{
                  width: 36,
                  height: 36,
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
              />
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "0.8rem",
                  color: "var(--text-2)",
                }}
              >
                {newColor.toUpperCase()}
              </span>
              {/* Quick presets */}
              {[
                "#f97316",
                "#ef4444",
                "#6b7280",
                "#60a5fa",
                "#06b6d4",
                "#22c55e",
                "#f472b6",
                "#8b5cf6",
              ].map((c) => (
                <button
                  key={c}
                  onClick={() => setNewColor(c)}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: c,
                    border:
                      newColor === c
                        ? "2px solid #fff"
                        : "1.5px solid transparent",
                    cursor: "pointer",
                    transition: "all var(--t)",
                  }}
                />
              ))}
            </div>
          </div>

          {/* Preview */}
          <div style={{ marginBottom: "1.25rem" }}>
            <label className="label" style={{ marginBottom: "0.5rem" }}>
              Podgląd
            </label>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                background: moodBg(newColor, 0.2),
                border: `1px solid ${moodBg(newColor, 0.4)}`,
                borderRadius: "var(--radius)",
                padding: "0.35rem 0.75rem",
                color: newColor,
                fontWeight: 700,
                fontSize: "0.85rem",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: newColor,
                  display: "inline-block",
                }}
              />
              {emojiMode === "type" ? customEmoji || "💡" : newEmoji}{" "}
              {newLabel || "Nazwa moodu"}
            </div>
          </div>

          <div style={{ display: "flex", gap: "0.6rem" }}>
            <button
              className="btn btn-primary"
              onClick={handleAddMood}
              disabled={!newLabel.trim()}
              style={{ flex: 1, justifyContent: "center" }}
            >
              Utwórz folder
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setShowNewMood(false)}
            >
              Anuluj
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ── HookCard ─────────────────────────────────────────────── */

function HookCard({
  hook,
  mood,
  active,
  onUse,
  onRemove,
}: {
  hook: TextHook;
  mood?: MoodFolder;
  active: boolean;
  onUse: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="card card-p"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "1rem",
        border: active ? "1px solid var(--purple)" : undefined,
        background: active ? "var(--purple-dim)" : undefined,
      }}
    >
      {/* Mood color bar */}
      {mood && (
        <div
          style={{
            width: 3,
            alignSelf: "stretch",
            borderRadius: 99,
            flexShrink: 0,
            background: mood.color,
          }}
        />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: "0.9rem",
            lineHeight: 1.55,
            marginBottom: "0.45rem",
          }}
        >
          "{hook.text}"
        </p>
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {mood && (
            <span
              style={{
                background: moodBg(mood.color, 0.15),
                color: mood.color,
                padding: "0.1rem 0.5rem",
                borderRadius: "99px",
                fontSize: "0.68rem",
                fontWeight: 700,
              }}
            >
              {mood.emoji} {mood.label}
            </span>
          )}
          {active && <span className="badge badge-green">✓ W studio</span>}
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.4rem", flexShrink: 0 }}>
        <button
          className={`btn btn-sm ${active ? "btn-ghost" : "btn-primary"}`}
          onClick={onUse}
        >
          {active ? "Wybrano" : "→ Studio"}
        </button>
        <button className="btn btn-sm btn-danger" onClick={onRemove}>
          ✕
        </button>
      </div>
    </div>
  );
}

/* ── Modal ─────────────────────────────────────────────────── */

function Modal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.7)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
      onClick={onClose}
    >
      <div
        className="card card-p fade-in"
        style={{
          width: "100%",
          maxWidth: 440,
          maxHeight: "90vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
