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
import { type FontName } from "./fonts.js";

// ── Preset config type ────────────────────────────────────

export type CaptionStyle   = "bold_center" | "karaoke" | "karaoke_pill" | "minimal_clean";
export type ClipCutStrategy = "beat" | "random";
export type HookAnimation   = "pop" | "slide" | "fade" | "none";
export type ColorGrade =
  | "dark_contrast"
  | "vibrant"
  | "muted"
  | "warm"
  | "cold"
  | "teal_orange"
  | "neon_glow"
  | "film_noir"
  | null;
export type Transition =
  | "none"
  | "fade"
  | "glitch"
  | "glitch_rgb"
  | "dissolve"
  | "wipeleft"
  | "pixelize"
  | "squeezev"
  | "zoomin"
  | "hblur";

export interface PresetConfig {
  captionStyle: CaptionStyle;
  captionColor: string;        // hex #RRGGBB — inactive / base text colour
  captionActiveColor?: string; // hex #RRGGBB — karaoke highlight fill colour
  clipCutStrategy: ClipCutStrategy;
  transition: Transition;
  zoomPunch: boolean;
  speedVariation: boolean;
  colorGrade: ColorGrade;
  energyBasedCuts: boolean;
  flashOnDrop?: boolean;          // white-flash overlay at detected drop timestamps
  filmGrain?: boolean;            // subtle temporal noise over each clip (analog warmth)
  vignette?: boolean;             // edge darkening lens vignette over each clip
  captionBoxBackground?: boolean; // semi-transparent box behind subtitle text (BorderStyle=3)
  captionWordsPerLine?: number;   // words grouped per subtitle line (default: 4)
  hookAnimation?: HookAnimation;  // entrance animation for the hook text overlay
  letterbox?: boolean;            // add cinematic black bars (12 % top/bottom)
  maxDuration?: number;           // seconds — overrides platform default if set
  captionFont?: FontName;         // bundled font for captions and hook overlay text
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
      captionActiveColor: "#FF0055",
      clipCutStrategy: "beat",
      transition: "glitch",
      zoomPunch: true,
      speedVariation: true,
      colorGrade: "dark_contrast",
      energyBasedCuts: true,
      flashOnDrop: true,
      vignette: true,
      maxDuration: 25,
      captionFont: "impact",
    },
  },
  {
    id: "hype_beat_1",
    name: "Hype Beat",
    moodId: "hype",
    config: {
      captionStyle: "bold_center",
      captionColor: "#FFFF00",
      captionActiveColor: "#FF8C00",
      clipCutStrategy: "beat",
      transition: "none",
      zoomPunch: true,
      speedVariation: false,
      colorGrade: "vibrant",
      energyBasedCuts: true,
      maxDuration: 20,
      captionFont: "impact",
    },
  },
  {
    id: "chill_minimal_1",
    name: "Chill Minimal",
    moodId: "chill",
    config: {
      captionStyle: "minimal_clean",
      captionColor: "#FFFFFF",
      captionActiveColor: "#06B6D4",
      clipCutStrategy: "random",
      transition: "dissolve",
      zoomPunch: false,
      speedVariation: false,
      colorGrade: "muted",
      energyBasedCuts: false,
      captionBoxBackground: true,
      captionWordsPerLine: 3,
      letterbox: true,
      maxDuration: 30,
      captionFont: "montserrat",
    },
  },
  {
    id: "aggressive_punch_1",
    name: "Aggressive Punch",
    moodId: "aggressive",
    config: {
      captionStyle: "bold_center",
      captionColor: "#FF3B3B",
      captionActiveColor: "#FFFF00",
      clipCutStrategy: "beat",
      transition: "wipeleft",
      zoomPunch: true,
      speedVariation: true,
      colorGrade: "dark_contrast",
      energyBasedCuts: true,
      flashOnDrop: true,
      maxDuration: 20,
      captionFont: "impact",
    },
  },
  {
    id: "aesthetic_fade_1",
    name: "Aesthetic Fade",
    moodId: "aesthetic",
    config: {
      captionStyle: "minimal_clean",
      captionColor: "#F472B6",
      captionActiveColor: "#FFFFFF",
      clipCutStrategy: "random",
      transition: "fade",
      zoomPunch: false,
      speedVariation: false,
      colorGrade: "warm",
      energyBasedCuts: false,
      filmGrain: true,
      vignette: true,
      letterbox: true,
      maxDuration: 25,
      captionFont: "montserrat",
    },
  },
  {
    id: "motivational_rise_1",
    name: "Motivational Rise",
    moodId: "motivational",
    config: {
      captionStyle: "bold_center",
      captionColor: "#22C55E",
      captionActiveColor: "#FFFF00",
      clipCutStrategy: "beat",
      transition: "none",
      zoomPunch: true,
      speedVariation: false,
      colorGrade: "vibrant",
      energyBasedCuts: true,
      maxDuration: 30,
      captionFont: "oswald",
    },
  },
  {
    id: "classic_clean_1",
    name: "Classic Clean",
    moodId: undefined,
    config: {
      captionStyle: "bold_center",
      captionColor: "#FFFFFF",
      captionActiveColor: "#FFFF00",
      clipCutStrategy: "beat",
      transition: "none",
      zoomPunch: false,
      speedVariation: false,
      colorGrade: null,
      energyBasedCuts: false,
      captionBoxBackground: true,
      captionWordsPerLine: 5,
      captionFont: "arial",
    },
  },
  {
    id: "tiktok_pill_1",
    name: "TikTok Pill",
    moodId: "hype",
    config: {
      captionStyle: "karaoke_pill",
      captionColor: "#FFFFFF",
      captionActiveColor: "#FF3B3B",
      clipCutStrategy: "beat",
      transition: "squeezev",
      zoomPunch: true,
      speedVariation: false,
      colorGrade: "vibrant",
      energyBasedCuts: true,
      flashOnDrop: true,
      maxDuration: 20,
      captionFont: "oswald",
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
      captionActiveColor: config.captionActiveColor ?? "#FFFF00",
      clipCutStrategy: config.clipCutStrategy ?? "beat",
      transition: config.transition ?? "none",
      zoomPunch: config.zoomPunch ?? false,
      speedVariation: config.speedVariation ?? false,
      colorGrade: config.colorGrade ?? null,
      energyBasedCuts:     config.energyBasedCuts ?? false,
      flashOnDrop:         config.flashOnDrop,
      filmGrain:           config.filmGrain,
      vignette:            config.vignette,
      captionBoxBackground: config.captionBoxBackground,
      captionWordsPerLine: config.captionWordsPerLine,
      hookAnimation:       config.hookAnimation,
      letterbox:           config.letterbox,
      maxDuration:         config.maxDuration,
      captionFont:         config.captionFont,
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

/**
 * Resolve the karaoke highlight (active word fill) colour from the priority chain:
 * 1. Explicit request colour
 * 2. Preset captionActiveColor
 * 3. Fallback yellow (#FFFF00) — the classic karaoke highlight
 */
export function resolveActiveColor(
  requestColor: string | undefined,
  preset: Preset | null,
): string {
  if (requestColor && requestColor !== "#FFFF00") return requestColor;
  if (preset?.config.captionActiveColor) return preset.config.captionActiveColor;
  return "#FFFF00";
}

export { DEFAULT_PRESETS, type PresetRecord };
