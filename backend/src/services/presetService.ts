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
  deletePreset,
  type PresetRecord,
} from "../utils/db.js";
import { type FontName } from "./fonts.js";
import { type CaptionAnimation } from "./captions.js";

// ── Preset config type ────────────────────────────────────

export type CaptionStyle   = "bold_center" | "karaoke" | "karaoke_pill" | "minimal_clean";
/** How much text per block: 1/2/3 words or 1/2/3 lines. */
export type CaptionDisplayMode =
  | "1_word"
  | "2_words"
  | "3_words"
  | "1_line"
  | "2_lines"
  | "3_lines";
/** Vertical position of captions: center or bottom (na dole). */
export type CaptionPosition = "center" | "bottom";
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
  flashOnDrop?: boolean;          // white-flash brightness overlay at detected drop timestamps
  freezeOnDrop?: boolean;         // freeze-frame + flash at detected drop timestamps (more dramatic)
  filmGrain?: boolean;            // subtle temporal noise over each clip (analog warmth)
  vignette?: boolean;             // edge darkening lens vignette over each clip
  captionBoxBackground?: boolean;   // semi-transparent box behind subtitle text (BorderStyle=3)
  captionWordsPerLine?: number;     // words grouped per subtitle line (default: 4)
  captionDisplayMode?: CaptionDisplayMode; // 1/2/3 words or 1/2/3 lines (default: 1_line)
  captionPosition?: CaptionPosition;      // center | bottom (na dole) — default: bottom
  hookAnimation?: HookAnimation;          // entrance animation for the hook text overlay
  letterbox?: boolean;            // add cinematic black bars (12 % top/bottom)
  maxDuration?: number;           // seconds — overrides platform default if set
  captionFont?: FontName;             // bundled font for captions and hook overlay text
  slowMotion?: boolean;               // enable slow-mo on keyword segments (minterpolate + setpts=2.0)
  slowMotionKeywords?: string[];      // override default keyword list for slow-mo detection
  captionAnimation?: CaptionAnimation; // pop | bounce | fade | scale_in | slide_up | none
  /** When true, napisy nie są wypalane w wideo — użytkownik dostaje wideo + osobny plik .ass (soft subs). */
  captionsAsLayer?: boolean;
  description?: string; // short human-readable description of the preset (for UI)
  /** ASS outline width (0–12). Stronger outline = more punch / viral look. */
  captionOutline?: number;
  /** ASS shadow depth (0–6). Higher = softer glow / neon feel. */
  captionShadow?: number;
  /** ASS letter spacing (-2 to 10). Negative = tighter; positive = more air. */
  captionSpacing?: number;
  /** Override font size in px. If unset, style default is used (e.g. height/21). */
  captionFontSize?: number;
  /** Text hook at top of video for full duration (e.g. "MY CURRENT POV", "THIS SONG IS A BANGER"). */
  textHook?: string;
  /** When true, 1/2/3-word mode shows cumulative text (Hey → Hey brother → …). */
  captionConcatWords?: boolean;
  /** Custom fade-in in ms (text entering). Used when captionAnimation is "fade". */
  captionFadeInMs?: number;
  /** Custom fade-out in ms (text exiting). Used when captionAnimation is "fade". */
  captionFadeOutMs?: number;
  /** Luminous glow: outline colour = text colour (white halo, viral look). */
  captionGlow?: boolean;
}

export interface Preset {
  id: string;
  name: string;
  moodId?: string;
  config: PresetConfig;
}

// ── Slow-motion keyword defaults ─────────────────────────
// Segments whose lyrics contain any of these words trigger a 2× slow-down
// with minterpolate frame-blending (50 % speed, smooth motion).
export const SLOW_MOTION_KEYWORDS: string[] = [
  "slow",  "feel",   "moment", "break",  "fall",
  "wait",  "stay",   "love",   "miss",   "hold",
  "fade",  "drift",  "breathe","pause",  "still",
  "gone",  "heart",  "alone",  "dream",  "lost",
];

// ── No built-in presets: users save mix config as presets from Studio ─────

// Legacy default preset IDs — removed on first load so DB only has user presets
const LEGACY_DEFAULT_IDS = [
  "dark_glitch_1", "hype_beat_1", "chill_minimal_1", "aggressive_punch_1",
  "aesthetic_fade_1", "motivational_rise_1", "classic_clean_1", "tiktok_pill_1",
  "viral_punch_1", "pro_karaoke_1", "luminous_pov_1", "capcut_viral_1",
  "reels_glow_1", "story_aesthetic_1", "neon_nights_1", "trendy_bold_1",
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

// ── One-time cleanup of legacy built-in presets ───────────

let _cleaned = false;

/** Remove legacy default presets from DB so only user-created presets remain. Idempotent. */
export function seedDefaultPresets(): void {
  if (_cleaned) return;
  _cleaned = true;
  for (const id of LEGACY_DEFAULT_IDS) {
    try {
      deletePreset(id);
    } catch {
      // ignore if already missing
    }
  }
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
      freezeOnDrop:        config.freezeOnDrop,
      filmGrain:           config.filmGrain,
      vignette:            config.vignette,
      captionBoxBackground: config.captionBoxBackground,
      captionWordsPerLine: config.captionWordsPerLine,
      captionDisplayMode:   config.captionDisplayMode,
      captionPosition:     config.captionPosition,
      hookAnimation:        config.hookAnimation,
      letterbox:            config.letterbox,
      maxDuration:          config.maxDuration,
      captionFont:          config.captionFont,
      slowMotion:           config.slowMotion,
      slowMotionKeywords:   config.slowMotionKeywords,
      captionAnimation:     config.captionAnimation,
      captionOutline:       config.captionOutline,
      captionShadow:       config.captionShadow,
      captionSpacing:      config.captionSpacing,
      captionFontSize:     config.captionFontSize,
      textHook:            config.textHook,
      captionConcatWords:  config.captionConcatWords,
      captionFadeInMs:     config.captionFadeInMs,
      captionFadeOutMs:    config.captionFadeOutMs,
      captionGlow:         config.captionGlow,
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

export type { PresetRecord };
