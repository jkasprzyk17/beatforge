/* eslint-disable react-refresh/only-export-components */
/**
 * Global app state shared across all pages.
 *
 * Persistence:
 *   - Tracks, transcriptions → persisted by backend (tracks API)
 *   - Collections → persisted via /api/collections
 *   - Hooks       → persisted via /api/hooks
 *   - Presets     → persisted via /api/presets
 *   - Moods       → in-memory (DEFAULT_MOODS + user additions per session)
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import {
  fetchTracks,
  getCachedTranscription,
  transcribeTrack,
  fetchCollections,
  fetchHooks,
  fetchPresets,
  type PresetApiRecord,
  type Composition,
} from "../lib/api";

// ── MoodFolder ────────────────────────────────────────────

export interface MoodFolder {
  id: string;
  label: string;
  emoji: string;
  color: string;
  isDefault: boolean;
}

export const DEFAULT_MOODS: MoodFolder[] = [
  {
    id: "high-energy",
    label: "High Energy",
    emoji: "⚡",
    color: "#f97316",
    isDefault: true,
  },
  { id: "hype", label: "Hype", emoji: "🔥", color: "#ef4444", isDefault: true },
  { id: "dark", label: "Dark", emoji: "🖤", color: "#6b7280", isDefault: true },
  { id: "sad", label: "Sad", emoji: "💔", color: "#60a5fa", isDefault: true },
  {
    id: "chill",
    label: "Chill",
    emoji: "🌊",
    color: "#06b6d4",
    isDefault: true,
  },
  {
    id: "aggressive",
    label: "Aggressive",
    emoji: "👊",
    color: "#dc2626",
    isDefault: true,
  },
  {
    id: "aesthetic",
    label: "Aesthetic",
    emoji: "🌸",
    color: "#f472b6",
    isDefault: true,
  },
  {
    id: "motivational",
    label: "Motivational",
    emoji: "🚀",
    color: "#22c55e",
    isDefault: true,
  },
];

// ── Core types ────────────────────────────────────────────

export interface Track {
  id: string;
  name: string;
  size: number;
  musicId: string;
  bpm?: number;
  duration?: number;
  uploadedAt: Date;
}

export interface Clip {
  id: string;
  name: string;
  size: number;
  clipsId?: string;
  duration?: number;
  uploadedAt: Date;
}

export interface Collection {
  id: string;
  name: string;
  clips: Clip[];
  folderId?: string;
  createdAt: Date;
  thumbnailUrl?: string;
}

export interface TextHook {
  id: string;
  text: string;
  category: string; // maps to MoodFolder.id
  createdAt: Date;
}

export interface Preset {
  id: string;
  name: string;
  moodId?: string;
  config: PresetApiRecord["config"];
}

export type LyricStyle =
  | "brat"
  | "caps"
  | "statement"
  | "classic"
  | "simple"
  | "bold";

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  word?: boolean;
}

// Re-export for pages that import PresetApiRecord type
export type { PresetApiRecord };

// ── Context shape ─────────────────────────────────────────

interface AppState {
  tracks: Track[];
  clips: Clip[];
  collections: Collection[];
  hooks: TextHook[];
  moods: MoodFolder[];
  presets: Preset[];

  // Studio selections
  /** Nazwa paczki mixów (np. "moje hype mixy edycja 5") — eksporty trafiają do /exports/slug. */
  studioPackName: string;
  studioTrackId: string | null;
  studioCollectionId: string | null;
  studioHookId: string | null;
  /** Folder (mood) z hookami — w Studio wybór „Folder (losowo)”;
   * przy generowaniu losowy hook z tego folderu na każdy wariant. */
  studioHookFolderId: string | null;
  studioPresetId: string | null;
  studioLyricStyle: LyricStyle;
  studioLyricColor: string;
  studioLyricActiveColor: string;
  /** Ilość tekstu: 1/2/3 słowa lub 1/2/3 linie. */
  studioCaptionDisplayMode: "1_word" | "2_words" | "3_words" | "1_line" | "2_lines" | "3_lines";
  /** Pozycja napisów: środek lub na dole. */
  studioCaptionPosition: "center" | "bottom";
  studioMoodId: string | null;

  // Composition (layer-based Studio)
  studioComposition: Composition | null;
  setStudioComposition: (c: Composition | null) => void;

  // Transcription cache per music_id
  transcriptions: Record<string, TranscriptionSegment[]>;

  // Tracks
  addTrack: (t: Track) => void;
  removeTrack: (id: string) => void;

  // Clips
  addClips: (clips: Clip[]) => void;
  removeClip: (id: string) => void;

  // Collections
  addCollection: (c: Collection) => void;
  removeCollection: (id: string) => void;
  renameCollection: (id: string, name: string) => void;
  setCollectionFolder: (
    collectionId: string,
    folderId: string | undefined,
  ) => void;
  reorderCollectionClips: (collectionId: string, clips: Clip[]) => void;

  // Hooks
  addHook: (h: TextHook) => void;
  addHooks: (hooks: TextHook[]) => void;
  removeHook: (id: string) => void;

  // Moods
  addMood: (m: MoodFolder) => void;
  removeMood: (id: string) => void;

  // Presets
  addPreset: (p: Preset) => void;

  // Studio
  setStudioPackName: (name: string) => void;
  setStudioTrack: (id: string | null) => void;
  setStudioCollection: (id: string | null) => void;
  setStudioHook: (id: string | null) => void;
  setStudioHookFolder: (moodId: string | null) => void;
  setStudioPreset: (id: string | null) => void;
  setStudioLyricStyle: (s: LyricStyle) => void;
  setStudioLyricColor: (c: string) => void;
  setStudioLyricActiveColor: (c: string) => void;
  setStudioCaptionDisplayMode: (m: "1_word" | "2_words" | "3_words" | "1_line" | "2_lines" | "3_lines") => void;
  setStudioCaptionPosition: (p: "center" | "bottom") => void;
  setStudioMood: (id: string | null) => void;
  setTranscription: (musicId: string, segments: TranscriptionSegment[]) => void;

  // Legacy compat
  studioClipIds: string[];
  setStudioClips: (ids: string[]) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [hooks, setHooks] = useState<TextHook[]>([]);
  const [moods, setMoods] = useState<MoodFolder[]>(DEFAULT_MOODS);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [transcriptions, setTranscriptions] = useState<
    Record<string, TranscriptionSegment[]>
  >({});

  const [studioPackName, setStudioPackName] = useState<string>("");
  const [studioTrackId, setStudioTrackId] = useState<string | null>(null);
  const [studioCollectionId, setStudioCollectionId] = useState<string | null>(
    null,
  );
  const [studioClipIds, setStudioClipIds] = useState<string[]>([]);
  const [studioHookId, setStudioHookId] = useState<string | null>(null);
  const [studioHookFolderId, setStudioHookFolderId] = useState<string | null>(null);
  const [studioPresetId, setStudioPresetId] = useState<string | null>(null);
  const [studioLyricStyle, setStudioLyricStyle] = useState<LyricStyle>("bold");
  const [studioLyricColor, setStudioLyricColor] = useState<string>("#FFFFFF");
  const [studioLyricActiveColor, setStudioLyricActiveColor] = useState<string>("#FFFF00");
  const [studioCaptionDisplayMode, setStudioCaptionDisplayMode] = useState<
    "1_word" | "2_words" | "3_words" | "1_line" | "2_lines" | "3_lines"
  >("1_line");
  const [studioCaptionPosition, setStudioCaptionPosition] = useState<"center" | "bottom">("bottom");
  const [studioMoodId, setStudioMoodId] = useState<string | null>(null);
  const [studioComposition, setStudioComposition] = useState<Composition | null>(null);

  // ── Mutators ───────────────────────────────────────────

  const addTrack = useCallback((t: Track) => setTracks((p) => [t, ...p]), []);
  const removeTrack = useCallback(
    (id: string) => setTracks((p) => p.filter((t) => t.id !== id)),
    [],
  );

  const addClips = useCallback(
    (c: Clip[]) => setClips((p) => [...c, ...p]),
    [],
  );
  const removeClip = useCallback(
    (id: string) => setClips((p) => p.filter((c) => c.id !== id)),
    [],
  );

  const addCollection = useCallback(
    (c: Collection) => setCollections((p) => [c, ...p]),
    [],
  );
  const removeCollection = useCallback(
    (id: string) => setCollections((p) => p.filter((c) => c.id !== id)),
    [],
  );
  const renameCollection = useCallback(
    (id: string, name: string) =>
      setCollections((p) => p.map((c) => (c.id === id ? { ...c, name } : c))),
    [],
  );
  const setCollectionFolder = useCallback(
    (collectionId: string, folderId: string | undefined) =>
      setCollections((p) =>
        p.map((c) => (c.id === collectionId ? { ...c, folderId } : c)),
      ),
    [],
  );
  const reorderCollectionClips = useCallback(
    (collectionId: string, clips: Clip[]) =>
      setCollections((p) =>
        p.map((c) => (c.id === collectionId ? { ...c, clips } : c)),
      ),
    [],
  );

  const addHook = useCallback((h: TextHook) => setHooks((p) => [h, ...p]), []);
  const addHooks = useCallback(
    (newHooks: TextHook[]) => setHooks((p) => [...newHooks, ...p]),
    [],
  );
  const removeHook = useCallback(
    (id: string) => setHooks((p) => p.filter((h) => h.id !== id)),
    [],
  );

  const addMood = useCallback(
    (m: MoodFolder) => setMoods((p) => [...p, m]),
    [],
  );
  const removeMood = useCallback(
    (id: string) =>
      setMoods((p) => p.filter((m) => m.isDefault || m.id !== id)),
    [],
  );

  const addPreset = useCallback(
    (p: Preset) => setPresets((prev) => [...prev, p]),
    [],
  );

  const setTranscription = useCallback(
    (musicId: string, segs: TranscriptionSegment[]) =>
      setTranscriptions((p) => ({ ...p, [musicId]: segs })),
    [],
  );

  // ── Hydration from backend on mount ───────────────────

  useEffect(() => {
    // Fetch everything in parallel, then flush all state in one pass
    // (avoids N separate re-renders — one call per resolved promise).
    Promise.allSettled([
      fetchTracks(),
      fetchCollections(),
      fetchHooks(),
      fetchPresets(),
    ]).then(async ([tracksRes, collectionsRes, hooksRes, presetsRes]) => {
      // ── tracks ──────────────────────────────────────────
      if (tracksRes.status === "fulfilled" && tracksRes.value.length) {
        const loaded: Track[] = tracksRes.value.map((r) => ({
          id: r.id,
          name: r.originalName.replace(/\.[^.]+$/, ""),
          size: r.size,
          musicId: r.id,
          uploadedAt: new Date(r.uploadedAt),
          duration: r.duration,
          bpm: r.bpm,
        }));

        // Fetch cached transcriptions only (GET). Never run Whisper on load.
        // User-edited text is in DB; we just load it. New transcription only when user selects track in Studio and clicks transcribe.
        const cachedMap: Record<string, TranscriptionSegment[]> = {};
        await Promise.all(
          loaded.map(async (t) => {
            const res = await getCachedTranscription(t.musicId);
            if (res?.segments?.length) {
              cachedMap[t.musicId] = res.segments;
            }
          }),
        );

        // Two state updates — React 18 batches them into one render
        setTracks(loaded);
        if (Object.keys(cachedMap).length) setTranscriptions(cachedMap);
      }

      // ── collections ──────────────────────────────────────
      if (collectionsRes.status === "fulfilled") {
        setCollections(
          collectionsRes.value.map((r) => ({
            id: r.id,
            name: r.name,
            folderId: r.folderId,
            createdAt: new Date(r.createdAt),
            thumbnailUrl: r.thumbnailUrl,
            clips: r.clipPaths.map((p, i) => ({
              id: `${r.id}_clip${i}`,
              name:
                p.split("/").pop()?.replace(/\.[^.]+$/, "") ?? `Clip ${i + 1}`,
              size: 0,
              clipsId: r.id,
              uploadedAt: new Date(r.createdAt),
            })),
          })),
        );
      }

      // ── hooks ────────────────────────────────────────────
      if (hooksRes.status === "fulfilled") {
        setHooks(
          hooksRes.value.map((r) => ({
            id: r.id,
            text: r.text,
            category: r.moodId ?? "high-energy",
            createdAt: new Date(r.createdAt),
          })),
        );
      }

      // ── presets ──────────────────────────────────────────
      if (presetsRes.status === "fulfilled") {
        setPresets(
          presetsRes.value.map((r) => ({
            id: r.id,
            name: r.name,
            moodId: r.moodId,
            config: r.config,
          })),
        );
      }
    });
  }, []);

  return (
    <Ctx.Provider
      value={{
        tracks,
        clips,
        collections,
        hooks,
        moods,
        presets,
        transcriptions,
        studioPackName,
        studioTrackId,
        studioCollectionId,
        studioClipIds,
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
        setStudioPackName,
        addTrack,
        removeTrack,
        addClips,
        removeClip,
        addCollection,
        removeCollection,
        renameCollection,
        setCollectionFolder,
        reorderCollectionClips,
        addHook,
        addHooks,
        removeHook,
        addMood,
        removeMood,
        addPreset,
        setStudioTrack: setStudioTrackId,
        setStudioCollection: setStudioCollectionId,
        setStudioClips: setStudioClipIds,
        setStudioHook: setStudioHookId,
        setStudioHookFolder: setStudioHookFolderId,
        setStudioPreset: setStudioPresetId,
        setStudioLyricStyle,
        setStudioLyricColor,
        setStudioLyricActiveColor,
        setStudioCaptionDisplayMode,
        setStudioCaptionPosition,
        setStudioMood: setStudioMoodId,
        setTranscription,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
