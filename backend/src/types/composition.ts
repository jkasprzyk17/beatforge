/**
 * Composition data model — layer-based video composition for BeatForge Studio.
 * All randomized behavior must use composition.seed with mulberry32 (no Math.random).
 */

export type AspectRatio = "9:16" | "1:1" | "4:5" | "16:9";
export type ResizeMode = "cover" | "contain" | "letterbox";

/** Vertical output: full 9:16 or 1:1 content centered in 9:16 with black bars. */
export type OutputDisplayMode = "full" | "1:1_letterbox";

export type LayerType =
  | "video_base"
  | "hook"
  | "lyrics"
  | "custom_text"
  | "cinematic_bars"
  | "color_grade";

export interface CompositionLayer {
  id: string;
  type: LayerType;
  start: number;
  end: number;
  zIndex: number;
  config: Record<string, unknown>;
}

export interface CustomTextConfig {
  text: string;
  font: string;
  fontSize: number;
  color: string;
  bgBox?: boolean;
  position: "top" | "center" | "bottom" | "custom";
  x?: number;
  y?: number;
  animation: "pop" | "slide" | "fade";
}

export interface Composition {
  id: string;
  audioId: string;
  aspectRatio: AspectRatio;
  resizeMode: ResizeMode;
  /** When "1:1_letterbox", content is 1:1 centered in 9:16 with black bars top/bottom. Default "full". */
  outputDisplayMode?: OutputDisplayMode;
  seed?: number;
  layers: CompositionLayer[];
}

/** Resolution map for aspect ratios (width × height). */
export const ASPECT_RATIO_RESOLUTIONS: Record<AspectRatio, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1":  { width: 1080, height: 1080 },
  "4:5":  { width: 1080, height: 1350 },
  "16:9": { width: 1920, height: 1080 },
};

export function getResolution(aspectRatio: AspectRatio): { width: number; height: number } {
  return ASPECT_RATIO_RESOLUTIONS[aspectRatio] ?? ASPECT_RATIO_RESOLUTIONS["9:16"];
}
