/**
 * Preset engine — loads, validates and seeds presets.
 *
 * A Preset encapsulates everything that affects the video style:
 * caption style, color, clip cut strategy, transitions, zoom,
 * speed variation, color grading, and max duration.
 */

import {
  savePreset,
  getPreset,
  getAllPresets,
  type PresetRecord,
} from "../utils/db.js";

// ── Preset config type ────────────────────────────────────

export type CaptionStyle = "bold_center" | "karaoke" | "minimal_clean";
export type ClipCutStrategy = "beat" | "random";
export type ColorGrade =
  | "dark_contrast"
  | "vibrant"
  | "muted"
  | "warm"
  | "cold"
  | null;
export type Transition =
  | "none"
  | "fade"
  | "glitch"
  | "dissolve"
  | "wipeleft"
  | "pixelize";

export interface PresetConfig {
  captionStyle: CaptionStyle;
  captionColor: string; // hex #RRGGBB
  clipCutStrategy: ClipCutStrategy;
  transition: Transition;
  zoomPunch: boolean;
  speedVariation: boolean;
  colorGrade: ColorGrade;
  energyBasedCuts: boolean;
  maxDuration?: number; // seconds — overrides platform default if set
}

export interface Preset {
  id: string;
  name: string;
  moodId?: string;
  config: PresetConfig;
}

// ── Default presets ───────────────────────────────────────

const DEFAULT_PRESETS: Preset[] = [
  {
    id: "dark_glitch_1",
    name: "Dark Glitch",
    moodId: "dark",
    config: {
      captionStyle: "bold_center",
      captionColor: "#FF0055",
      clipCutStrategy: "beat",
      transition: "glitch",
      zoomPunch: true,
      speedVariation: true,
      colorGrade: "dark_contrast",
      energyBasedCuts: true,
      maxDuration: 25,
    },
  },
  {
    id: "hype_beat_1",
    name: "Hype Beat",
    moodId: "hype",
    config: {
      captionStyle: "bold_center",
      captionColor: "#FFFF00",
      clipCutStrategy: "beat",
      transition: "none",
      zoomPunch: true,
      speedVariation: false,
      colorGrade: "vibrant",
      energyBasedCuts: true,
      maxDuration: 20,
    },
  },
  {
    id: "chill_minimal_1",
    name: "Chill Minimal",
    moodId: "chill",
    config: {
      captionStyle: "minimal_clean",
      captionColor: "#FFFFFF",
      clipCutStrategy: "random",
      transition: "dissolve",
      zoomPunch: false,
      speedVariation: false,
      colorGrade: "muted",
      energyBasedCuts: false,
      maxDuration: 30,
    },
  },
  {
    id: "aggressive_punch_1",
    name: "Aggressive Punch",
    moodId: "aggressive",
    config: {
      captionStyle: "bold_center",
      captionColor: "#FF3B3B",
      clipCutStrategy: "beat",
      transition: "wipeleft",
      zoomPunch: true,
      speedVariation: true,
      colorGrade: "dark_contrast",
      energyBasedCuts: true,
      maxDuration: 20,
    },
  },
  {
    id: "aesthetic_fade_1",
    name: "Aesthetic Fade",
    moodId: "aesthetic",
    config: {
      captionStyle: "minimal_clean",
      captionColor: "#F472B6",
      clipCutStrategy: "random",
      transition: "fade",
      zoomPunch: false,
      speedVariation: false,
      colorGrade: "warm",
      energyBasedCuts: false,
      maxDuration: 25,
    },
  },
  {
    id: "motivational_rise_1",
    name: "Motivational Rise",
    moodId: "motivational",
    config: {
      captionStyle: "bold_center",
      captionColor: "#22C55E",
      clipCutStrategy: "beat",
      transition: "none",
      zoomPunch: true,
      speedVariation: false,
      colorGrade: "vibrant",
      energyBasedCuts: true,
      maxDuration: 30,
    },
  },
  {
    id: "classic_clean_1",
    name: "Classic Clean",
    moodId: undefined,
    config: {
      captionStyle: "bold_center",
      captionColor: "#FFFFFF",
      clipCutStrategy: "beat",
      transition: "none",
      zoomPunch: false,
      speedVariation: false,
      colorGrade: null,
      energyBasedCuts: false,
    },
  },
];

// Mood → default caption color fallback
export const MOOD_DEFAULT_COLORS: Record<string, string> = {
  "high-energy": "#F97316",
  hype: "#FFFF00",
  dark: "#FF0055",
  sad: "#60A5FA",
  chill: "#06B6D4",
  aggressive: "#FF3B3B",
  aesthetic: "#F472B6",
  motivational: "#22C55E",
};

// ── Seed defaults on startup ──────────────────────────────

let _seeded = false;

export function seedDefaultPresets(): void {
  if (_seeded) return;
  _seeded = true;
  const existing = getAllPresets();
  const existingIds = new Set(existing.map((p) => p.id));
  for (const p of DEFAULT_PRESETS) {
    if (!existingIds.has(p.id)) {
      savePreset({
        id: p.id,
        name: p.name,
        moodId: p.moodId,
        config: p.config,
      });
    }
  }
  console.log(`[presets] Seeded ${DEFAULT_PRESETS.length} default presets`);
}

// ── Load & validate ───────────────────────────────────────

export function loadPreset(id: string): Preset | null {
  const rec = getPreset(id);
  if (!rec) return null;
  const config = rec.config as Partial<PresetConfig>;

  return {
    id: rec.id,
    name: rec.name,
    moodId: rec.moodId,
    config: {
      captionStyle: config.captionStyle ?? "bold_center",
      captionColor: config.captionColor ?? "#FFFFFF",
      clipCutStrategy: config.clipCutStrategy ?? "beat",
      transition: config.transition ?? "none",
      zoomPunch: config.zoomPunch ?? false,
      speedVariation: config.speedVariation ?? false,
      colorGrade: config.colorGrade ?? null,
      energyBasedCuts: config.energyBasedCuts ?? false,
      maxDuration: config.maxDuration,
    },
  };
}

/**
 * Resolve the final caption color from the priority chain:
 * 1. Explicit request color
 * 2. Preset captionColor
 * 3. Mood default color
 * 4. Fallback white
 */
export function resolveCaptionColor(
  requestColor: string | undefined,
  preset: Preset | null,
  moodId: string | undefined,
): string {
  if (requestColor && requestColor !== "#FFFFFF") return requestColor;
  if (preset?.config.captionColor) return preset.config.captionColor;
  if (moodId && MOOD_DEFAULT_COLORS[moodId]) return MOOD_DEFAULT_COLORS[moodId];
  return "#FFFFFF";
}

export { DEFAULT_PRESETS, type PresetRecord };
