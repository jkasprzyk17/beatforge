/**
 * Composition engine — layer-based FFmpeg filter graph generation.
 *
 * Builds a single filter_complex (or -vf) string from a Composition:
 * scale/crop or pad → color grade → cinematic bars → hook → lyrics → custom text layers.
 * All layers applied in zIndex order. Deterministic when composition.seed is set.
 *
 * Example composition JSON:
 * {
 *   "id": "comp_1",
 *   "audioId": "track_abc",
 *   "aspectRatio": "9:16",
 *   "resizeMode": "cover",
 *   "seed": 42,
 *   "layers": [
 *     { "id": "l0", "type": "video_base", "start": 0, "end": 9999, "zIndex": 0, "config": {} },
 *     { "id": "l1", "type": "cinematic_bars", "start": 0, "end": 9999, "zIndex": 1, "config": { "barRatio": 0.1 } },
 *     { "id": "l2", "type": "custom_text", "start": 1, "end": 4, "zIndex": 2, "config": { "text": "Hello", "font": "arial", "fontSize": 48, "color": "#FFFFFF", "position": "center", "animation": "pop", "bgBox": true } }
 *   ]
 * }
 *
 * Example final FFmpeg command (with composition):
 *   ffmpeg -y -i concat.mp4 -i music.mp3 -vf "<buildFilterGraph output>" -map 0:v -map 1:a -c:v libx264 -preset fast -crf 20 -c:a aac -b:a 192k -t 30.0 -pix_fmt yuv420p out.mp4
 * (Run with cwd = directory containing the .ass file when subtitles layer is used.)
 */

import path from "node:path";
import type { ColorGrade } from "./presetService.js";
import { getColorGradeFilter } from "./filtergraph.js";
import { drawtextFontOpt, escapePathForFilter, subtitlesFontsDirOpt, type FontName } from "./fonts.js";
import type {
  Composition,
  CompositionLayer,
  CustomTextConfig,
  AspectRatio,
  ResizeMode,
} from "../types/composition.js";
import { getResolution } from "../types/composition.js";

// ── Resolution & scale/crop/pad ─────────────────────────────

export interface CompositionBuildContext {
  width: number;
  height: number;
  /** When set (e.g. 1080×1920 for 1:1_letterbox), pad content to this size after all layers. */
  outputWidth?: number;
  outputHeight?: number;
  assPath?: string;
  assDir?: string;
  fontsDir?: string;
  hookText?: string;
  hookAnimation?: "pop" | "slide" | "fade" | "none";
  font?: FontName;
  /** Hook text color (hex e.g. #FFFFFF). */
  hookColor?: string;
  /** Hook shadow depth 0–6. */
  hookShadow?: number;
  fps?: number;
  /** When set, append global fade in/out to the whole edit. */
  videoDurationSeconds?: number;
}

/**
 * FFmpeg filter fragment: scale input to fit target size, then either
 * crop (cover) or pad (contain/letterbox) to exact W×H.
 */
export function buildScaleCropPad(
  width: number,
  height: number,
  resizeMode: ResizeMode,
): string {
  if (resizeMode === "cover") {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  }
  // contain or letterbox: scale to fit, then pad with black
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
}

/**
 * Escape drawtext special characters so FFmpeg parses correctly.
 */
function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%");
}

/**
 * Build drawtext option for custom text with animation.
 * Uses enable='between(t,start,end)' and animation expressions for alpha/y.
 */
function buildCustomTextDrawtext(
  config: CustomTextConfig,
  start: number,
  end: number,
  width: number,
  height: number,
  font?: FontName,
): string {
  const safeText = escapeDrawtext(config.text);
  const fontSize = Math.min(400, Math.max(12, config.fontSize || 48));
  const color = config.color?.startsWith("#") ? config.color : "#FFFFFF";
  const fontOpt = config.font ? drawtextFontOpt(config.font as FontName) : drawtextFontOpt(font);

  const S = start.toFixed(2);
  const E = end.toFixed(2);
  const D = (end - start).toFixed(2);
  // enable: only show between start and end
  const enable = `enable='between(t\\,${S}\\,${E})'`;

  // Local time within the layer: t - start
  const tLocal = `t-${S}`;

  let xExpr: string;
  let yExpr: string;
  let alphaExpr: string;

  switch (config.position) {
    case "top":
      xExpr = "(w-text_w)/2";
      yExpr = "h*0.08";
      break;
    case "bottom":
      xExpr = "(w-text_w)/2";
      yExpr = "h-h*0.12-text_h";
      break;
    case "center":
      xExpr = "(w-text_w)/2";
      yExpr = "(h-text_h)/2";
      break;
    case "custom":
      xExpr = config.x != null ? String(Math.round(config.x)) : "(w-text_w)/2";
      yExpr = config.y != null ? String(Math.round(config.y)) : "(h-text_h)/2";
      break;
    default:
      xExpr = "(w-text_w)/2";
      yExpr = "(h-text_h)/2";
  }

  const fadeDur = 0.4;
  switch (config.animation) {
    case "slide": {
      // Slide from top: y from -text_h to target over 0.4s
      const targetY = config.position === "top" ? "h*0.08" : config.position === "bottom" ? "h-h*0.12-text_h" : "(h-text_h)/2";
      yExpr = `if(lt(${tLocal}\\,${fadeDur})\\,-text_h+(${tLocal}/${fadeDur})*(${targetY}+text_h)\\,${targetY})`;
      alphaExpr = "1";
      break;
    }
    case "pop": {
      // Fast alpha burst (0.12s)
      alphaExpr = `if(lt(${tLocal}\\,0.12)\\,${tLocal}/0.12\\,1)`;
      break;
    }
    case "fade": {
      alphaExpr = `if(lt(${tLocal}\\,${fadeDur})\\,${tLocal}/${fadeDur}\\,1)`;
      break;
    }
    default:
      alphaExpr = "1";
  }

  const parts = [
    `text='${safeText}'`,
    fontOpt,
    `fontsize=${fontSize}`,
    `x=${xExpr}`,
    `y='${yExpr}'`,
    `fontcolor=${color}`,
    `alpha='${alphaExpr}'`,
    enable,
  ];
  if (config.bgBox) {
    parts.push("box=1", "boxcolor=black@0.5", "boxborderw=10");
  }
  parts.push("shadowcolor=black@0.6", "shadowx=2", "shadowy=2");

  return "drawtext=" + parts.join(":");
}

/**
 * Build cinematic letterbox bars (drawbox top + bottom).
 */
function buildCinematicBarsFilter(barRatio: number): string {
  const pct = Math.min(25, Math.max(5, Math.round(barRatio * 100)));
  return [
    `drawbox=x=0:y=0:w=iw:h=trunc(ih*${pct}/100):color=black:t=fill`,
    `drawbox=x=0:y=ih-trunc(ih*${pct}/100):w=iw:h=trunc(ih*${pct}/100):color=black:t=fill`,
  ].join(",");
}

/**
 * Build the full filter graph string for a composition.
 * Input: one video stream [0:v]. Output: one video stream.
 * Layers are applied in zIndex order; only layers that have context data (e.g. hook, lyrics)
 * or full config (custom_text, color_grade, cinematic_bars) are applied.
 */
export function buildFilterGraph(
  composition: Composition,
  context: CompositionBuildContext,
): string {
  const { width, height, outputWidth, outputHeight } = context;
  const sortedLayers = [...composition.layers].sort((a, b) => a.zIndex - b.zIndex);
  const isLetterbox = outputWidth != null && outputHeight != null && (outputWidth !== width || outputHeight !== height);

  const fragments: string[] = [];
  let hasLyricsLayer = false;

  // 1. Scale + crop or pad to content size (e.g. 1080×1080 for 1:1_letterbox)
  fragments.push(buildScaleCropPad(width, height, composition.resizeMode));

  // 2. When letterbox, pad to output first so hook/lyrics are drawn on full frame (hook in top black bar)
  if (isLetterbox) {
    fragments.push(
      `pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2:black`,
    );
  }

  for (const layer of sortedLayers) {
    switch (layer.type) {
      case "video_base":
        // No filter — base is already the scaled video
        break;
      case "color_grade": {
        const grade = layer.config?.grade as ColorGrade | undefined;
        if (grade) {
          const gf = getColorGradeFilter(grade);
          if (gf) fragments.push(gf);
        }
        break;
      }
      case "cinematic_bars": {
        const barRatio = (layer.config?.barRatio as number) ?? 0.1;
        fragments.push(buildCinematicBarsFilter(barRatio));
        break;
      }
      case "hook": {
        const text = (context.hookText ?? (layer.config?.text as string)) || "";
        if (!text) break;
        const anim = (context.hookAnimation ?? layer.config?.animation) ?? "fade";
        const displayDuration = Math.max(0.5, (layer.end - layer.start) || 10);
        const hookEnd = layer.start + displayDuration;
        const safeText = escapeDrawtext(text);
        const S = layer.start.toFixed(2);
        const E = hookEnd.toFixed(2);
        const fadeOut = `if(gt(t\\,${E}-0.3)\\,(${E}-t)/0.3\\,1)`;
        const outH = outputHeight ?? height;
        const outW = outputWidth ?? width;
        const hookFontSize = Math.round(outH / 6);
        const yCenterTopBar = isLetterbox ? Math.round((outH - height) / 4) : Math.round(outH * 0.06);
        let alphaExpr: string = fadeOut;
        let yExpr: string;
        if (anim === "slide") {
          yExpr = `if(lt(t\\,0.35)\\,${yCenterTopBar + Math.round(outH * 0.05)}*(1-t/0.35)+${yCenterTopBar}*t/0.35\\,${yCenterTopBar})`;
        } else {
          yExpr = String(yCenterTopBar);
        }
        if (anim === "fade") {
          alphaExpr = `if(lt(t\\,0.5)\\,t/0.5\\,${fadeOut})`;
        } else if (anim === "pop") {
          alphaExpr = `if(lt(t\\,0.12)\\,t/0.12\\,${fadeOut})`;
        } else if (anim !== "slide") {
          alphaExpr = fadeOut;
        }
        const yOpt = yExpr.includes("if(") ? `y='${yExpr}'` : `y=${yExpr}`;
        const hookColorHex = (context.hookColor ?? "#FFFFFF").replace(/^#/, "").trim();
        const hookFontColor = /^[0-9A-Fa-f]{6}$/.test(hookColorHex) ? "0x" + hookColorHex : "0xFFFFFF";
        const hookShadow = context.hookShadow ?? 2;
        const hookParts = [
          `text='${safeText}'`,
          drawtextFontOpt(context.font),
          `fontsize=${hookFontSize}`,
          `x=(w-text_w)/2`,
          yOpt,
          `fontcolor=${hookFontColor}`,
          `alpha='${alphaExpr}'`,
          `box=1`,
          `boxcolor=black@0.45`,
          `boxborderw=14`,
          `enable='between(t\\,${S}\\,${E})'`,
        ];
        if (hookShadow > 0) {
          hookParts.push("shadowcolor=black@0.6", `shadowx=${hookShadow}`, `shadowy=${hookShadow}`);
        }
        fragments.push("drawtext=" + hookParts.join(":"));
        break;
      }
      case "lyrics": {
        hasLyricsLayer = true;
        if (context.assPath) {
          const assFile = path.basename(context.assPath);
          const fontsDirOpt =
            context.fontsDir && process.platform !== "win32"
              ? `:fontsdir=${escapePathForFilter(context.fontsDir)}`
              : "";
          fragments.push(`subtitles=${assFile}${fontsDirOpt}`);
        }
        break;
      }
      case "custom_text": {
        const cfg = layer.config as unknown as CustomTextConfig;
        if (cfg?.text) {
          fragments.push(
            buildCustomTextDrawtext(
              cfg,
              layer.start,
              layer.end,
              width,
              height,
              context.font,
            ),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  // Gdy mamy plik ASS (napisy) ale composition nie ma warstwy "lyrics" (np. domyślna kompozycja),
  // i tak wypal napisy — żeby tekst piosenki zawsze był w wideo.
  if (context.assPath && !hasLyricsLayer) {
    const assFile = path.basename(context.assPath);
    const fontsDirOpt =
      context.fontsDir && process.platform !== "win32"
        ? `:fontsdir=${escapePathForFilter(context.fontsDir)}`
        : "";
    fragments.push(`subtitles=${assFile}${fontsDirOpt}`);
  }

  // Global fade in/out so the whole edit (including hook/captions) doesn't start or end with a hard cut.
  const dur = context.videoDurationSeconds;
  if (dur != null && dur > 0) {
    const fadeInD = 0.4;
    const fadeOutD = 0.4;
    const fadeOutStart = Math.max(fadeInD, dur - fadeOutD);
    fragments.push(`fade=t=in:st=0:d=${fadeInD},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutD}`);
  }

  return fragments.join(",");
}

/**
 * Get width and height for an aspect ratio (for use in build context).
 */
export function getResolutionForAspectRatio(
  aspectRatio: AspectRatio,
): { width: number; height: number } {
  return getResolution(aspectRatio);
}
