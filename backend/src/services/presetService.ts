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
      captionBoxBackground: true,
      maxDuration: 25,
      captionFont: "impact",
      captionAnimation: "pop",
      description: "Jak działa: Ciemna paleta, cięcia na bit, przejście glitch i błysk na drop. Idealny pod hip-hop i mocne bity.\nConfig: styl bold_center, kolor #FF0055, box tło, font Impact, animacja pop, przejście glitch, zoom, vignette, max 25 s.",
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
      captionBoxBackground: true,
      maxDuration: 20,
      captionFont: "impact",
      captionAnimation: "pop",
      freezeOnDrop: true,
      description: "Jak działa: Żywe kolory, cięcia na bit, zoom punch i freeze-frame na drop. Prosty i dynamiczny — świetny pod TikTok i Reels.\nConfig: styl bold_center, kolor żółty/pomarańczowy, box tło, font Impact, animacja pop, freeze na drop, max 20 s.",
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
      slowMotion: true,
      captionAnimation: "fade",
      description: "Jak działa: Spokojne ujęcia, rozmyte przejścia, letterbox i delikatny slow-mo na wybranych słowach. Minimalistyczne napisy.\nConfig: styl minimal_clean, biały/cyan, 3 słowa na linię, letterbox, font Montserrat, animacja fade, slow-mo, przejście dissolve, max 30 s.",
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
      freezeOnDrop: true,
      captionBoxBackground: true,
      maxDuration: 20,
      captionFont: "impact",
      captionAnimation: "pop",
      description: "Jak działa: Mocne cięcia na bit, przejście w lewo, zoom i freeze-frame na drop. Czerwono-żółte napisy, wysokie tempo.\nConfig: styl bold_center, kolor czerwony/żółty, box tło, font Impact, animacja pop, przejście wipeleft, zoom, freeze na drop, max 20 s.",
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
      slowMotion: true,
      captionAnimation: "fade",
      description: "Jak działa: Ciepłe kolory, ziarno filmowe, vinietka i letterbox. Fade między ujęciami, slow-mo na kluczowych słowach — vibe „soft aesthetic”.\nConfig: styl minimal_clean, różowy/biały, letterbox, film grain, vignette, font Montserrat, animacja fade, slow-mo, max 25 s.",
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
      captionAnimation: "bounce",
      description: "Jak działa: Zielono-żółte napisy, cięcia na bit, lekki zoom. Odpowiedni pod motywacyjne i energetyczne utwory.\nConfig: styl bold_center, zielony/żółty, font Oswald, animacja bounce, cięcia na bit, zoom, max 30 s.",
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
      captionAnimation: "fade",
      description: "Jak działa: Uniwersalny preset — białe napisy, cięcia na bit, bez efektów. Czytelny i neutralny styl.\nConfig: styl bold_center, biały/żółty, box tło, 5 słów na linię, font Arial, animacja fade, bez zoomu, max bez limitu.",
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
      freezeOnDrop: true,
      maxDuration: 20,
      captionFont: "oswald",
      captionAnimation: "pop",
      description: "Jak działa: Napis w „pigułce” (karaoke pill), przejście squeeze, żywe kolory. Styl popularny na TikTok.\nConfig: styl karaoke_pill, biały/czerwony, font Oswald, animacja pop, przejście squeezev, zoom, freeze na drop, max 20 s.",
    },
  },
  {
    id: "viral_punch_1",
    name: "Viral Punch",
    moodId: "hype",
    config: {
      captionStyle: "bold_center",
      captionColor: "#FFFFFF",
      captionActiveColor: "#FFFF00",
      clipCutStrategy: "beat",
      transition: "zoomin",
      zoomPunch: true,
      speedVariation: true,
      colorGrade: "vibrant",
      energyBasedCuts: true,
      flashOnDrop: true,
      captionBoxBackground: true,
      captionOutline: 8,
      captionShadow: 3,
      captionSpacing: 0,
      captionFontSize: 92,
      maxDuration: 20,
      captionFont: "impact",
      captionAnimation: "slide_up",
      description: "Jak działa: Gruby obrys, napisy wjeżdżające z dołu, większa czcionka. Semi-pro, viral look — idealny pod Reels i TikTok.\nConfig: styl bold_center, biały/żółty, outline 8, shadow 3, font 92px Impact, 1 linia, box tło, animacja slide_up, przejście zoomin, flash na drop, max 20 s.",
    },
  },
  {
    id: "pro_karaoke_1",
    name: "Pro Karaoke",
    moodId: "hype",
    config: {
      captionStyle: "karaoke",
      captionColor: "#E0E0E0",
      captionActiveColor: "#00D4AA",
      clipCutStrategy: "beat",
      transition: "fade",
      zoomPunch: true,
      speedVariation: false,
      colorGrade: "teal_orange",
      energyBasedCuts: true,
      captionBoxBackground: true,
      captionOutline: 6,
      captionShadow: 2,
      captionSpacing: 1,
      captionWordsPerLine: 4,
      captionDisplayMode: "1_line",
      captionPosition: "center",
      maxDuration: 25,
      captionFont: "oswald",
      captionAnimation: "scale_in",
      description: "Jak działa: Karaoke z delikatnym wejściem (scale_in), kolory teal/orange, napisy na środku. Czysty, semi-pro styl.\nConfig: styl karaoke, szary/teal, outline 6, shadow 2, 1 linia, środek, font Oswald, box tło, animacja scale_in, przejście fade, max 25 s.",
    },
  },
  // ── CapCut-style / viral social presets ─────────────────
  {
    id: "luminous_pov_1",
    name: "Luminous POV",
    moodId: "aesthetic",
    config: {
      captionStyle: "bold_center",
      captionColor: "#FFFFFF",
      captionActiveColor: "#FFFFFF",
      clipCutStrategy: "beat",
      transition: "fade",
      zoomPunch: false,
      speedVariation: false,
      colorGrade: "dark_contrast",
      energyBasedCuts: false,
      captionGlow: true,
      captionOutline: 8,
      captionShadow: 4,
      captionDisplayMode: "2_words",
      captionPosition: "center",
      captionConcatWords: true,
      captionAnimation: "fade",
      captionFadeInMs: 200,
      captionFadeOutMs: 150,
      maxDuration: 25,
      captionFont: "impact",
      vignette: true,
      description: "Jak działa: Biały tekst z mocnym halo (glow), słowa łańcuchem (2 słowa), środek kadru. Viral POV / „Jaki znak twój?” — idealny pod Reels i TikTok.\nConfig: styl bold_center, biały, glow ON, outline 8, shadow 4, 2 słowa łańcuchem, środek, fade in 200 ms / out 150 ms, font Impact, dark contrast, vignette, max 25 s.",
    },
  },
  {
    id: "capcut_viral_1",
    name: "CapCut Viral",
    moodId: "hype",
    config: {
      captionStyle: "bold_center",
      captionColor: "#FFFFFF",
      captionActiveColor: "#FFFF00",
      clipCutStrategy: "beat",
      transition: "zoomin",
      zoomPunch: true,
      speedVariation: true,
      colorGrade: "vibrant",
      energyBasedCuts: true,
      flashOnDrop: true,
      captionGlow: true,
      captionOutline: 8,
      captionShadow: 4,
      captionSpacing: 0,
      captionFontSize: 92,
      captionBoxBackground: false,
      captionDisplayMode: "1_line",
      captionPosition: "center",
      maxDuration: 20,
      captionFont: "impact",
      captionAnimation: "slide_up",
      description: "Jak działa: Gruby biały glow, napisy wjeżdżające z dołu, zoom na bit, błysk na drop. Styl CapCut / viral Reels.\nConfig: styl bold_center, biały/żółty, glow ON, outline 8, shadow 4, font 92px Impact, 1 linia środek, animacja slide_up, przejście zoomin, flash na drop, max 20 s.",
    },
  },
  {
    id: "reels_glow_1",
    name: "Reels Glow",
    moodId: "hype",
    config: {
      captionStyle: "karaoke",
      captionColor: "#FFFFFF",
      captionActiveColor: "#00E5FF",
      clipCutStrategy: "beat",
      transition: "fade",
      zoomPunch: true,
      speedVariation: false,
      colorGrade: "vibrant",
      energyBasedCuts: true,
      captionGlow: true,
      captionOutline: 6,
      captionShadow: 3,
      captionDisplayMode: "2_words",
      captionPosition: "center",
      captionConcatWords: true,
      captionAnimation: "fade",
      captionFadeInMs: 180,
      captionFadeOutMs: 120,
      maxDuration: 22,
      captionFont: "oswald",
      description: "Jak działa: Karaoke z białym glow i cyanowym wypełnieniem, słowa łańcuchem. Czysty, trendy look pod Reels.\nConfig: styl karaoke, biały/cyan (#00E5FF), glow ON, outline 6, shadow 3, 2 słowa łańcuchem, środek, fade 180/120 ms, font Oswald, przejście fade, max 22 s.",
    },
  },
  {
    id: "story_aesthetic_1",
    name: "Story Aesthetic",
    moodId: "aesthetic",
    config: {
      captionStyle: "minimal_clean",
      captionColor: "#FEF3C7",
      captionActiveColor: "#FDE68A",
      clipCutStrategy: "random",
      transition: "fade",
      zoomPunch: false,
      speedVariation: false,
      colorGrade: "warm",
      energyBasedCuts: false,
      captionGlow: true,
      captionOutline: 4,
      captionShadow: 2,
      captionBoxBackground: false,
      letterbox: true,
      filmGrain: true,
      vignette: true,
      maxDuration: 30,
      captionFont: "montserrat",
      captionAnimation: "fade",
      captionFadeInMs: 250,
      captionFadeOutMs: 200,
      slowMotion: true,
      description: "Jak działa: Ciepłe kolory, delikatny glow, letterbox i ziarno. Soft aesthetic — idealny pod Stories i mood clips.\nConfig: styl minimal_clean, kremowy/żółty, glow ON, outline 4, shadow 2, letterbox, film grain, vignette, font Montserrat, fade 250/200 ms, slow-mo, max 30 s.",
    },
  },
  {
    id: "neon_nights_1",
    name: "Neon Nights",
    moodId: "dark",
    config: {
      captionStyle: "bold_center",
      captionColor: "#FFFFFF",
      captionActiveColor: "#A78BFA",
      clipCutStrategy: "beat",
      transition: "glitch_rgb",
      zoomPunch: true,
      speedVariation: true,
      colorGrade: "neon_glow",
      energyBasedCuts: true,
      flashOnDrop: true,
      captionGlow: true,
      captionOutline: 6,
      captionShadow: 4,
      captionDisplayMode: "1_word",
      captionPosition: "center",
      captionConcatWords: true,
      maxDuration: 20,
      captionFont: "impact",
      captionAnimation: "pop",
      description: "Jak działa: Neonowa paleta, biały glow, słowo po słowie, glitch RGB. Mocny, klubowy vibe — TikTok i Reels.\nConfig: styl bold_center, biały/fiolet, glow ON, outline 6, shadow 4, 1 słowo łańcuchem, środek, font Impact, animacja pop, przejście glitch_rgb, neon_glow grade, flash na drop, max 20 s.",
    },
  },
  {
    id: "trendy_bold_1",
    name: "Trendy Bold",
    moodId: "hype",
    config: {
      captionStyle: "bold_center",
      captionColor: "#FFFFFF",
      captionActiveColor: "#FF6B35",
      clipCutStrategy: "beat",
      transition: "dissolve",
      zoomPunch: true,
      speedVariation: false,
      colorGrade: "teal_orange",
      energyBasedCuts: true,
      captionGlow: true,
      captionOutline: 7,
      captionShadow: 3,
      captionDisplayMode: "3_words",
      captionPosition: "center",
      captionConcatWords: true,
      captionAnimation: "bounce",
      maxDuration: 25,
      captionFont: "impact",
      captionBoxBackground: false,
      description: "Jak działa: Biały glow, 3 słowa łańcuchem, bounce wejście. Teal/orange grading — uniwersalny viral look.\nConfig: styl bold_center, biały/pomarańczowy, glow ON, outline 7, shadow 3, 3 słowa łańcuchem, środek, font Impact, animacja bounce, przejście dissolve, zoom, max 25 s.",
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

export { DEFAULT_PRESETS, type PresetRecord };
