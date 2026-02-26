/**
 * Clips — MP4 clip manager with MoodFolder-based grouping
 *
 * Layout:
 *   Left: folder sidebar (mood list + add custom)
 *   Right: collections grid for selected mood (or "All")
 *
 * Each uploaded batch becomes a Collection assigned to a MoodFolder.
 */

import React, { useRef, useState } from "react";
import { useApp } from "../context/AppContext";
import type { Clip, Collection, MoodFolder } from "../context/AppContext";
import {
  uploadClips,
  createCollection,
  patchCollection,
  removeCollection as apiRemoveCollection,
} from "../lib/api";

interface Props {
  onGoToStudio: () => void;
}

const fmt = (b: number) =>
  b < 1048576
    ? `${(b / 1024).toFixed(0)} KB`
    : `${(b / 1048576).toFixed(1)} MB`;

let _clipId = 1;
const uid = () => `clip_${Date.now()}_${_clipId++}`;

export default function Clips({ onGoToStudio }: Props) {
  const {
    clips,
    addClips,
    removeClip,
    collections,
    addCollection,
    removeCollection,
    renameCollection,
    setCollectionFolder,
    moods,
    addMood,
    removeMood,
    setStudioCollection,
    studioCollectionId,
  } = useApp();

  const [activeMoodId, setActiveMoodId] = useState<string>("all");
  const [showAddMood, setShowAddMood] = useState(false);
  const [newMoodLabel, setNewMoodLabel] = useState("");
  const [newMoodEmoji, setNewMoodEmoji] = useState("🎵");
  const [newMoodColor, setNewMoodColor] = useState("#8b5cf6");

  const [showUpload, setShowUpload] = useState(false);
  const [uploadFolder, setUploadFolder] = useState<string>("none");
  const [uploadName, setUploadName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);

  // ── filtered collections ─────────────────────────────────
  const visibleCollections =
    activeMoodId === "all"
      ? collections
      : activeMoodId === "none"
        ? collections.filter((c) => !c.folderId)
        : collections.filter((c) => c.folderId === activeMoodId);

  const countFor = (id: string) =>
    id === "all"
      ? collections.length
      : id === "none"
        ? collections.filter((c) => !c.folderId).length
        : collections.filter((c) => c.folderId === id).length;

  // ── upload ───────────────────────────────────────────────
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const arr = Array.from(files);
    const allowed = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
    const bad = arr.filter(
      (f) => !allowed.some((e) => f.name.toLowerCase().endsWith(e)),
    );
    if (bad.length) {
      setUploadErr(
        `Nieobsługiwany format: ${bad.map((f) => f.name).join(", ")}`,
      );
      return;
    }
    setUploadErr(null);
    setUploading(true);
    try {
      const res = await uploadClips(arr);
      const newClips: Clip[] = arr.map((f) => ({
        id: uid(),
        name: f.name.replace(/\.[^.]+$/, ""),
        size: f.size,
        clipsId: res.clips_id,
        uploadedAt: new Date(),
      }));
      addClips(newClips);

      const mood = moods.find((m) => m.id === uploadFolder);
      const colName =
        uploadName.trim() ||
        (mood
          ? `${mood.emoji} ${mood.label} ${collections.length + 1}`
          : `Kolekcja ${new Date().toLocaleDateString("pl-PL", { day: "2-digit", month: "short" })}`);

      const folderId = uploadFolder === "none" ? undefined : uploadFolder;
      const newCol: Collection = {
        id: res.clips_id,
        name: colName,
        clips: newClips,
        folderId,
        createdAt: new Date(),
      };

      // Persist to backend (fire-and-forget — UI updates immediately)
      createCollection({
        id: res.clips_id,
        name: colName,
        folder_id: folderId,
      }).catch((err) => console.warn("[collections] persist failed:", err));

      addCollection(newCol);
      setUploadName("");
      setShowUpload(false);
      if (uploadFolder !== "none") setActiveMoodId(uploadFolder);
    } catch (e: unknown) {
      setUploadErr(e instanceof Error ? e.message : "Błąd uploadu.");
    } finally {
      setUploading(false);
    }
  };

  // ── custom mood ──────────────────────────────────────────
  const handleAddMood = () => {
    if (!newMoodLabel.trim()) return;
    const id = `custom-${Date.now()}`;
    addMood({
      id,
      label: newMoodLabel.trim(),
      emoji: newMoodEmoji,
      color: newMoodColor,
      isDefault: false,
    });
    setNewMoodLabel("");
    setShowAddMood(false);
    setActiveMoodId(id);
  };

  const handleRenameCollection = (id: string, name: string) => {
    renameCollection(id, name);
    patchCollection(id, { name }).catch((err) =>
      console.warn("[collections] rename failed:", err),
    );
  };

  const handleFolderChange = (id: string, folderId: string | undefined) => {
    setCollectionFolder(id, folderId);
    patchCollection(id, { folder_id: folderId ?? "" }).catch((err) =>
      console.warn("[collections] folder update failed:", err),
    );
  };

  const handleRemoveCollection = (id: string) => {
    removeCollection(id);
    apiRemoveCollection(id).catch((err) =>
      console.warn("[collections] delete failed:", err),
    );
  };

  const useInStudio = (colId: string) => {
    setStudioCollection(colId);
    onGoToStudio();
  };

  return (
    <div
      className="fade-in"
      style={{ height: "100%", display: "flex", overflow: "hidden" }}
    >
      {/* ── Left: Mood sidebar ── */}
      <div
        style={{
          width: 200,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          padding: "1.25rem 0",
          overflowY: "auto",
        }}
      >
        <p
          className="label"
          style={{ padding: "0 1rem", marginBottom: "0.6rem" }}
        >
          Vibe / Mood
        </p>

        {/* All */}
        <FolderItem
          label="Wszystkie"
          emoji="🗂"
          color="var(--purple)"
          count={countFor("all")}
          active={activeMoodId === "all"}
          onClick={() => setActiveMoodId("all")}
        />
        {/* Ungrouped */}
        {countFor("none") > 0 && (
          <FolderItem
            label="Bez folderu"
            emoji="📂"
            color="var(--text-3)"
            count={countFor("none")}
            active={activeMoodId === "none"}
            onClick={() => setActiveMoodId("none")}
          />
        )}

        <div
          style={{
            height: 1,
            background: "var(--border)",
            margin: "0.5rem 1rem",
          }}
        />

        {/* Mood folders */}
        {moods.map((mood) => (
          <FolderItem
            key={mood.id}
            label={mood.label}
            emoji={mood.emoji}
            color={mood.color}
            count={countFor(mood.id)}
            active={activeMoodId === mood.id}
            onClick={() => setActiveMoodId(mood.id)}
            onDelete={mood.isDefault ? undefined : () => removeMood(mood.id)}
          />
        ))}

        {/* Add custom mood */}
        <div style={{ padding: "0.5rem 0.75rem", marginTop: "0.25rem" }}>
          {showAddMood ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.4rem",
              }}
            >
              <div style={{ display: "flex", gap: "0.3rem" }}>
                <input
                  className="input"
                  placeholder="Emoji"
                  value={newMoodEmoji}
                  onChange={(e) => setNewMoodEmoji(e.target.value)}
                  style={{
                    width: 46,
                    textAlign: "center",
                    padding: "0.35rem 0.3rem",
                    fontSize: "1rem",
                  }}
                  maxLength={2}
                />
                <input
                  className="input"
                  placeholder="Nazwa…"
                  value={newMoodLabel}
                  onChange={(e) => setNewMoodLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddMood()}
                  style={{
                    flex: 1,
                    padding: "0.35rem 0.5rem",
                    fontSize: "0.78rem",
                  }}
                  autoFocus
                />
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
              >
                <input
                  type="color"
                  value={newMoodColor}
                  onChange={(e) => setNewMoodColor(e.target.value)}
                  style={{
                    width: 28,
                    height: 28,
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    padding: 0,
                  }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleAddMood}
                  style={{ flex: 1, justifyContent: "center" }}
                >
                  Dodaj
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowAddMood(false)}
                >
                  ✕
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn btn-ghost btn-sm w-full"
              onClick={() => setShowAddMood(true)}
              style={{
                justifyContent: "center",
                fontSize: "0.75rem",
                opacity: 0.65,
              }}
            >
              + Nowy folder
            </button>
          )}
        </div>
      </div>

      {/* ── Right: Collections panel ── */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "1rem 1.5rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            {(() => {
              const m = moods.find((m) => m.id === activeMoodId);
              const label =
                activeMoodId === "all"
                  ? "Wszystkie kolekcje"
                  : activeMoodId === "none"
                    ? "Bez folderu"
                    : m
                      ? `${m.emoji} ${m.label}`
                      : "Kolekcje";
              return (
                <div>
                  <h2 style={{ fontSize: "1rem", fontWeight: 700 }}>{label}</h2>
                  <p className="text-xs text-3">
                    {visibleCollections.length} kolekcji · {clips.length} klipów
                    łącznie
                  </p>
                </div>
              );
            })()}
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowUpload((v) => !v)}
          >
            {showUpload ? "✕ Anuluj" : "⬆ Upload klipów"}
          </button>
        </div>

        {/* Upload panel */}
        {showUpload && (
          <div
            style={{
              padding: "1rem 1.5rem",
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-2)",
            }}
          >
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                marginBottom: "0.75rem",
                flexWrap: "wrap",
              }}
            >
              {/* Name */}
              <div>
                <p className="label" style={{ marginBottom: "0.3rem" }}>
                  Nazwa kolekcji
                </p>
                <input
                  className="input"
                  placeholder="np. Aggressive Highlights…"
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  style={{ width: 220 }}
                />
              </div>
              {/* Folder */}
              <div>
                <p className="label" style={{ marginBottom: "0.3rem" }}>
                  Folder / Mood
                </p>
                <select
                  className="input"
                  value={uploadFolder}
                  onChange={(e) => setUploadFolder(e.target.value)}
                  style={{ width: 180 }}
                >
                  <option value="none">Bez folderu</option>
                  {moods.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.emoji} {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Drop zone */}
            <div
              className={`dropzone ${drag ? "drag" : ""}`}
              style={{ padding: "1.25rem" }}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                handleFiles(e.dataTransfer.files);
              }}
            >
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".mp4,.mov,.avi,.mkv,.webm"
                style={{ display: "none" }}
                onChange={(e) => handleFiles(e.target.files)}
              />
              {uploading ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                  }}
                >
                  <div className="spinner" />
                  <p className="dropzone-sub pulse">Uploaduję…</p>
                </div>
              ) : (
                <>
                  <div className="dropzone-icon" style={{ fontSize: "1.5rem" }}>
                    🎞️
                  </div>
                  <p className="dropzone-title">Upuść klipy lub kliknij</p>
                  <p className="dropzone-sub">
                    MP4 · MOV · AVI · MKV · WEBM — najlepiej 2–5 s
                  </p>
                </>
              )}
            </div>
            {uploadErr && (
              <p
                style={{
                  color: "var(--red)",
                  fontSize: "0.8rem",
                  marginTop: "0.5rem",
                }}
              >
                ⚠ {uploadErr}
              </p>
            )}
          </div>
        )}

        {/* Collections grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: "1.25rem 1.5rem" }}>
          {visibleCollections.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">🎬</div>
              <p className="empty-title">
                {activeMoodId === "all"
                  ? "Brak kolekcji"
                  : "Brak kolekcji w tym folderze"}
              </p>
              <p className="empty-sub">
                {activeMoodId === "all"
                  ? "Wgraj pierwsze klipy MP4 aby zacząć"
                  : "Wgraj klipy i przypisz je do tego folderu"}
              </p>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setShowUpload(true)}
                style={{ marginTop: "0.75rem" }}
              >
                ⬆ Upload klipów
              </button>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                gap: "0.85rem",
              }}
            >
              {visibleCollections.map((col) => (
                <CollectionCard
                  key={col.id}
                  collection={col}
                  moods={moods}
                  inStudio={studioCollectionId === col.id}
                  isRenaming={renamingId === col.id}
                  renameVal={renameVal}
                  onRenameChange={setRenameVal}
                  onStartRename={() => {
                    setRenamingId(col.id);
                    setRenameVal(col.name);
                  }}
                  onCommitRename={() => {
                    if (renameVal.trim())
                      handleRenameCollection(col.id, renameVal.trim());
                    setRenamingId(null);
                  }}
                  onFolderChange={(fid) =>
                    handleFolderChange(col.id, fid === "none" ? undefined : fid)
                  }
                  onUseInStudio={() => useInStudio(col.id)}
                  onRemove={() => handleRemoveCollection(col.id)}
                  onRemoveClip={removeClip}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Folder sidebar item ────────────────────────────────── */

function FolderItem({
  label,
  emoji,
  color,
  count,
  active,
  onClick,
  onDelete,
}: {
  label: string;
  emoji: string;
  color: string;
  count: number;
  active: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.45rem 0.85rem 0.45rem 1rem",
        cursor: "pointer",
        transition: "all var(--t)",
        background: active ? "var(--purple-dim)" : "transparent",
        borderRight: active
          ? "2px solid var(--purple)"
          : "2px solid transparent",
        position: "relative",
      }}
      onMouseEnter={(e) => {
        if (!active)
          (e.currentTarget as HTMLElement).style.background =
            "rgba(255,255,255,0.03)";
      }}
      onMouseLeave={(e) => {
        if (!active)
          (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      <span style={{ fontSize: "0.95rem" }}>{emoji}</span>
      <span
        style={{
          flex: 1,
          fontSize: "0.8rem",
          fontWeight: active ? 700 : 500,
          color: active ? "var(--text)" : "var(--text-2)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {count > 0 && (
        <span
          style={{
            fontSize: "0.65rem",
            fontWeight: 700,
            background: active ? "var(--purple)" : "var(--bg-4)",
            color: active ? "#fff" : "var(--text-3)",
            borderRadius: 99,
            padding: "0.1rem 0.4rem",
            minWidth: 18,
            textAlign: "center",
          }}
        >
          {count}
        </span>
      )}
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-3)",
            fontSize: "0.65rem",
            padding: "0 0.1rem",
            opacity: 0,
            transition: "opacity var(--t)",
          }}
          className="folder-delete-btn"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/* ── Collection card ────────────────────────────────────── */

function CollectionCard({
  collection,
  moods,
  inStudio,
  isRenaming,
  renameVal,
  onRenameChange,
  onStartRename,
  onCommitRename,
  onFolderChange,
  onUseInStudio,
  onRemove,
  onRemoveClip,
}: {
  collection: Collection;
  moods: MoodFolder[];
  inStudio: boolean;
  isRenaming: boolean;
  renameVal: string;
  onRenameChange: (v: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onFolderChange: (folderId: string) => void;
  onUseInStudio: () => void;
  onRemove: () => void;
  onRemoveClip: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const mood = moods.find((m) => m.id === collection.folderId);

  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: `1.5px solid ${inStudio ? "var(--green)" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        overflow: "hidden",
        transition: "border-color var(--t)",
      }}
    >
      {/* Thumbnail area */}
      <div
        style={{
          aspectRatio: "16/9",
          background: "var(--bg-4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "2rem",
          color: "var(--text-3)",
          position: "relative",
          cursor: "pointer",
        }}
        onClick={onUseInStudio}
      >
        🎬
        {inStudio && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(34,197,94,0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ fontSize: "1.4rem" }}>✓</span>
          </div>
        )}
        {/* Mood badge */}
        {mood && (
          <div
            style={{
              position: "absolute",
              top: "0.4rem",
              left: "0.4rem",
              background: "rgba(0,0,0,0.7)",
              backdropFilter: "blur(4px)",
              borderRadius: 6,
              padding: "0.15rem 0.4rem",
              fontSize: "0.6rem",
              fontWeight: 700,
              color: mood.color,
              display: "flex",
              alignItems: "center",
              gap: "0.2rem",
            }}
          >
            {mood.emoji} {mood.label}
          </div>
        )}
        <div
          style={{
            position: "absolute",
            bottom: "0.4rem",
            right: "0.4rem",
            background: "rgba(0,0,0,0.65)",
            borderRadius: 6,
            padding: "0.15rem 0.4rem",
            fontSize: "0.62rem",
            color: "rgba(255,255,255,0.7)",
          }}
        >
          {collection.clips.length} klipów
        </div>
      </div>

      {/* Info */}
      <div style={{ padding: "0.6rem 0.75rem" }}>
        {isRenaming ? (
          <input
            className="input"
            value={renameVal}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(e) => e.key === "Enter" && onCommitRename()}
            autoFocus
            style={{
              fontSize: "0.8rem",
              padding: "0.25rem 0.5rem",
              width: "100%",
            }}
          />
        ) : (
          <p
            className="truncate"
            style={{
              fontWeight: 700,
              fontSize: "0.82rem",
              cursor: "pointer",
              marginBottom: "0.3rem",
            }}
            onDoubleClick={onStartRename}
            title="Kliknij dwukrotnie aby zmienić nazwę"
          >
            {collection.name}
          </p>
        )}

        {/* Folder selector */}
        <select
          className="input"
          value={collection.folderId ?? "none"}
          onChange={(e) => onFolderChange(e.target.value)}
          style={{
            width: "100%",
            fontSize: "0.72rem",
            padding: "0.25rem 0.4rem",
            marginBottom: "0.5rem",
          }}
        >
          <option value="none">📂 Bez folderu</option>
          {moods.map((m) => (
            <option key={m.id} value={m.id}>
              {m.emoji} {m.label}
            </option>
          ))}
        </select>

        {/* Actions */}
        <div style={{ display: "flex", gap: "0.3rem" }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={onUseInStudio}
            style={{ flex: 1, justifyContent: "center", fontSize: "0.72rem" }}
          >
            → Studio
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setExpanded((v) => !v)}
            title="Pokaż klipy"
            style={{ fontSize: "0.72rem" }}
          >
            {expanded ? "▲" : "▼"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--red)", fontSize: "0.72rem" }}
            onClick={onRemove}
            title="Usuń kolekcję"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Expanded clips */}
      {expanded && collection.clips.length > 0 && (
        <div
          style={{
            padding: "0 0.75rem 0.75rem",
            borderTop: "1px solid var(--border)",
            paddingTop: "0.6rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.3rem",
          }}
        >
          {collection.clips.map((clip) => (
            <div
              key={clip.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.3rem 0.5rem",
                background: "var(--bg-4)",
                borderRadius: 6,
              }}
            >
              <span style={{ fontSize: "0.75rem" }}>🎬</span>
              <span
                className="truncate"
                style={{ flex: 1, fontSize: "0.72rem", color: "var(--text-2)" }}
              >
                {clip.name}
              </span>
              <button
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-3)",
                  fontSize: "0.65rem",
                }}
                onClick={() => onRemoveClip(clip.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
