/**
 * Preset-driven FFmpeg filtergraph builder.
 *
 * Responsibilities:
 *   - buildClipFilter()    — builds the -vf string for a single clip segment
 *   - concatSegments()     — concat with optional xfade transitions
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getEncoder } from "./platformProfiles.js";
import type { ColorGrade, Transition, HookAnimation } from "./presetService.js";
import { drawtextFontOpt, type FontName } from "./fonts.js";

// ── FFmpeg runner ─────────────────────────────────────────

function ffmpeg(args: string[]): Promise<void> {
  // Quote args with space, " or : so log is copy-paste safe (colons like 0:v:0 can turn into emoji in some terminals)
  const fullCmd = ["ffmpeg", "-y", ...args]
    .map((a) => (a.includes(" ") || a.includes('"') || a.includes(":") ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");
  console.log("[ffmpeg] Full command:", fullCmd);
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const errLines: string[] = [];
    proc.stderr.on("data", (d: Buffer) => errLines.push(d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ffmpeg error (code ${code}):\n${errLines.slice(-10).join("")}`,
          ),
        );
    });
    proc.on("error", (err) =>
      reject(new Error(`ffmpeg not found: ${err.message}`)),
    );
  });
}

// ── Color grade filter strings ────────────────────────────

function colorGradeFilter(grade: ColorGrade): string {
  switch (grade) {
    case "dark_contrast":
      return "eq=contrast=1.35:brightness=-0.06:saturation=1.4:gamma=0.9";
    case "vibrant":
      return "eq=saturation=1.8:contrast=1.15:brightness=0.02";
    case "muted":
      return "eq=saturation=0.55:contrast=0.9:brightness=0.01";
    case "warm":
      return "curves=r='0/0 128/145 255/255':g='0/0 128/128 255/240':b='0/0 128/110 255/220'";
    case "cold":
      return "curves=r='0/0 128/110 255/240':g='0/0 128/125 255/245':b='0/0 128/145 255/255'";
    // ── New grades ────────────────────────────────────────
    case "teal_orange":
      // Warm shadows pushed orange, highlights pushed teal — cinematic blockbuster look
      return (
        "curves=r='0/0 128/148 255/255':g='0/0 128/120 255/230':b='0/0 128/95 255/200'," +
        "eq=saturation=1.3:contrast=1.1"
      );
    case "neon_glow":
      // Hyper-saturated, gamma-lifted, edge-sharpened — neon club / cyberpunk
      return (
        "eq=saturation=2.2:contrast=1.2:gamma=0.85," +
        "unsharp=luma_msize_x=7:luma_msize_y=7:luma_amount=1.5"
      );
    case "film_noir":
      // Near-desaturated, crushed blacks, lifted highlights — classic monochrome drama
      return (
        "hue=s=0.15," +
        "eq=contrast=1.6:brightness=-0.08," +
        "curves=all='0/0 80/15 200/220 255/245'"
      );
    default:
      return "";
  }
}

/** Exported for composition engine — returns FFmpeg filter string for a color grade. */
export function getColorGradeFilter(grade: ColorGrade): string {
  return colorGradeFilter(grade);
}

// ── Build per-clip video filter ───────────────────────────

export interface ClipFilterOptions {
  width: number;
  height: number;
  fps: number;
  zoomPunch?: boolean;
  /** When zoomPunch is true, initial zoom multiplier (default 1.08). From variation for per-edit variety. */
  zoomPunchStrength?: number;
  speedVariation?: boolean;
  colorGrade?: ColorGrade;
  segmentIndex?: number; // used to vary speed per segment
  filmGrain?: boolean;   // adds subtle temporal noise (alls=8, allf=t+u)
  vignette?: boolean;    // adds edge-darkening lens vignette (angle PI/5)
  slowMotion?: boolean;  // frame-blend to 60 fps then setpts=2.0 for 50% speed
}

export function buildClipFilter(opts: ClipFilterOptions): string {
  const { width, height, fps } = opts;
  const filters: string[] = [];

  // Base: crop to aspect ratio then scale
  filters.push(`crop=in_h*${width}/${height}:in_h`);
  filters.push(`scale=${width}:${height}`);
  filters.push(`fps=${fps}`);

  // Zoom punch — snaps to zoomPunchStrength× on frame 1, decays ~0.03/frame back to 1.0.
  // Strength from variation (e.g. 1.04–1.12) for per-edit variety; default 1.08.
  // d=1 means one output frame per input frame (no buffering delay).
  if (opts.zoomPunch) {
    const z0 = Math.max(1.01, Math.min(1.2, opts.zoomPunchStrength ?? 1.08)).toFixed(3);
    filters.push(
      `zoompan=z='if(eq(on\\,1)\\,${z0}\\,max(1.0\\,zoom-0.03))':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`,
    );
  }

  // Optional speed variation — slight tempo changes between clips.
  // Even-indexed segments run at 0.92× (8% faster); odd at 1.08× (8% slower).
  // Skipped when slow-motion is active because setpts would conflict.
  if (opts.speedVariation && !opts.slowMotion) {
    const idx = opts.segmentIndex ?? 0;
    const pts  = idx % 2 === 0 ? 0.92 : 1.08;
    filters.push(`setpts=${pts}*PTS`);

    // Motion blur for sped-up segments only.
    // tblend=all_mode=average blends each frame with its predecessor — the temporal
    // average mimics the shutter blur a real camera produces during fast motion.
    // Applied after setpts so it operates on the accelerated frame sequence.
    // Omitted on slow (pts > 1) segments where inter-frame motion is already smooth.
    if (pts < 1.0) {
      filters.push("tblend=all_mode=average");
    }
  }

  // Slow-motion — keyword-triggered 50 % speed with interpolated frames.
  //
  // Pipeline (applied BEFORE colour grade so grading runs on the final frame set):
  //   minterpolate=fps=60:mi_mode=blend
  //     → smooth frame-blending doubles frame rate to 60 fps
  //       (cheaper than mci/motion-compensated; good quality for short clips)
  //   setpts=2.0*PTS
  //     → doubles every timestamp → 2× longer playback (50 % speed)
  //   fps=${fps}
  //     → re-enforce output fps so the encoder sees a predictable frame rate
  //
  // Source clip duration: callers (trimAndCrop) pass only duration/2 of source
  // footage when slowMotion is active so the output fills exactly the cut point.
  if (opts.slowMotion) {
    filters.push("minterpolate=fps=60:mi_mode=blend:vsbmc=1");
    filters.push("setpts=2.0*PTS");
    filters.push(`fps=${fps}`);
  }

  // Optional color grade
  if (opts.colorGrade) {
    const grade = colorGradeFilter(opts.colorGrade);
    if (grade) filters.push(grade);
  }

  // Film grain — temporal + uniform noise applied after grading.
  // alls=8 is subtle (range 0-100); allf=t+u = temporal + uniform spatial distribution.
  // Temporal flag (t) changes the noise pattern every frame, mimicking real film grain.
  if (opts.filmGrain) {
    filters.push("noise=alls=8:allf=t+u");
  }

  // Vignette — darkens edges in an oval gradient (classic lens fall-off).
  // angle=PI/5 (36°) gives a moderate vignette without crushing the corners.
  if (opts.vignette) {
    filters.push("vignette=PI/5");
  }

  return filters.join(",");
}

// ── Simple concat (no transitions) ───────────────────────

export async function concatSegments(
  segments: string[],
  output: string,
): Promise<void> {
  const listPath = output + ".txt";
  fs.writeFileSync(
    listPath,
    segments.map((s) => `file '${s}'`).join("\n"),
    "utf8",
  );

  await ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    output,
  ]);

  fs.unlinkSync(listPath);
}

// ── Concat with xfade transitions ────────────────────────

/**
 * Concat segments with xfade transitions.
 * @param transition - single transition for all cuts, or array of length segments.length - 1 for per-cut transitions (CapCut-style variety)
 */
export async function concatWithTransitions(
  segments: string[],
  durations: number[],
  transition: Transition | Transition[],
  output: string,
): Promise<void> {
  if (segments.length === 0) throw new Error("No segments to concat");
  if (segments.length === 1) {
    fs.copyFileSync(segments[0], output);
    return;
  }

  const perCut =
    Array.isArray(transition) && transition.length === segments.length - 1
      ? transition
      : null;
  const single = perCut ? null : (transition as Transition);

  // If every transition is "none", fall back to simple concat
  if (perCut ? perCut.every((t) => t === "none") : single === "none") {
    return concatSegments(segments, output);
  }

  const { codec, presetFlags, qualityFlags } = getEncoder();
  const xfadeDur = 0.08; // 80ms cross-fade — fast and snappy

  const xfadeMap: Record<string, string> = {
    fade:       "fade",
    glitch:     "pixelize",
    glitch_rgb: "pixelize", // per-cut glitch_rgb falls back to pixelize in xfade
    dissolve:   "dissolve",
    wipeleft:   "wipeleft",
    pixelize:   "pixelize",
    squeezev:   "squeezev",
    zoomin:     "zoomin",
    hblur:      "hblur",
  };

  const inputs = segments.flatMap((s) => ["-i", s]);
  let filter = "";
  let prevLabel = "[0:v]";
  let cumulativeDur = 0;

  for (let i = 1; i < segments.length; i++) {
    cumulativeDur += durations[i - 1];
    const offset = Math.max(0, cumulativeDur - xfadeDur * i);
    const outLabel = i === segments.length - 1 ? "[vout]" : `[v${i}]`;
    const t = perCut ? perCut[i - 1] : single!;
    const xfadeName = t === "none" ? "fade" : (xfadeMap[t] ?? "fade");

    filter += `${prevLabel}[${i}:v]xfade=transition=${xfadeName}:duration=${xfadeDur}:offset=${offset.toFixed(3)}${outLabel}`;
    if (i < segments.length - 1) filter += ";";
    prevLabel = outLabel;
  }

  await ffmpeg([
    ...inputs,
    "-filter_complex", filter,
    "-map", "[vout]",
    "-c:v", codec,
    ...presetFlags,
    ...qualityFlags(28),
    "-an",
    output,
  ]);
}

// ── Cinematic letterbox bars ──────────────────────────────

/**
 * Paint opaque black bars at the top and bottom of the video using `drawbox`,
 * simulating a cinematic 2.4:1 widescreen crop on a 9:16 frame.
 *
 * Default `barRatio` of 0.12 (12 %) gives bars of 230 px on a 1920 px-tall
 * frame (active area ≈ 1460 px = 76 % of height).  The filter uses integer
 * arithmetic expressions so it works with any output resolution.
 *
 * Applied to the silent concat output (before mux) so captions and the hook
 * overlay are subsequently burned on top of the bars.
 */
export async function applyLetterbox(
  inputPath: string,
  outputPath: string,
  barRatio = 0.12,
): Promise<void> {
  const pct = Math.round(barRatio * 100);
  const vf = [
    `drawbox=x=0:y=0:w=iw:h=trunc(ih*${pct}/100):color=black:t=fill`,
    `drawbox=x=0:y=ih-trunc(ih*${pct}/100):w=iw:h=trunc(ih*${pct}/100):color=black:t=fill`,
  ].join(",");

  const { codec, presetFlags, qualityFlags } = getEncoder();
  await ffmpeg([
    "-i",   inputPath,
    "-vf",  vf,
    "-c:v", codec, ...presetFlags, ...qualityFlags(23),
    "-c:a", "copy",
    outputPath,
  ]);
}

// ── Preset preview thumbnail ──────────────────────────────

/**
 * Generate a 160×90 JPEG thumbnail that previews what a preset looks like.
 *
 * Uses FFmpeg's lavfi `color` source (dark neutral background) so the
 * color-grade filter has something realistic to work on.  The preset name
 * is drawn in the caption colour in the bottom-left corner.
 *
 * Results are cached on disk by the caller — this function is called only
 * when the file does not yet exist.
 */
export async function burnPresetThumb(
  presetName: string,
  colorGrade: ColorGrade,
  captionColor: string,
  outputPath: string,
  font?: FontName,
): Promise<void> {
  // Escape drawtext special chars (same rules as burnHookOverlay)
  const safeName = presetName
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%");

  const grade     = colorGrade ? colorGradeFilter(colorGrade) : null;
  const textColor = captionColor.startsWith("#") ? captionColor : "#FFFFFF";

  const drawt = [
    `drawtext=text='${safeName}'`,
    drawtextFontOpt(font),
    `fontsize=13`,
    `x=6`,
    `y=h-22`,
    `fontcolor=${textColor}`,
    `shadowcolor=black@0.85`,
    `shadowx=1`,
    `shadowy=1`,
  ].join(":");

  const vf = grade ? `${grade},${drawt}` : drawt;

  await ffmpeg([
    "-f",       "lavfi",
    "-i",       "color=c=#3d3d4f:size=160x90:rate=1",
    "-vf",      vf,
    "-frames:v", "1",
    "-q:v",     "3", // JPEG quality (1=best, 31=worst)
    outputPath,
  ]);
}

// ── Hook text overlay ─────────────────────────────────────

/**
 * Burn a short hook / CTA text onto a video using FFmpeg's drawtext filter.
 *
 * Text always sits in the top 1/4 of the frame: y ≈ 6% from top, font size = height/8,
 * with a semi-transparent black box behind it for legibility.
 *
 * Entrance animations (all share a 300 ms alpha fade-out at the end):
 *   fade  — 500 ms alpha fade-in
 *   pop   — 120 ms fast alpha burst-in
 *   slide — 350 ms y-slide from 5% below the final position
 *   none  — instant appear
 *
 * drawtext special-char escaping (spawn, no shell layer):
 *   \  →  \\   (literal backslash in rendered text)
 *   '  →  \'   (literal single-quote inside quoted option value)
 *   :  →  \:   (literal colon so drawtext doesn't mistake it for an option sep)
 *   %  →  %%   (literal percent — otherwise treated as a timestamp format spec)
 */
/** Hex #RRGGBB to drawtext fontcolor 0xRRGGBB. */
function hexToDrawtextColor(hex: string): string {
  const m = hex.replace(/^#/, "").trim();
  if (/^[0-9A-Fa-f]{6}$/.test(m)) return "0x" + m;
  return "0xFFFFFF";
}

export async function burnHookOverlay(
  inputPath: string,
  outputPath: string,
  text: string,
  animation: HookAnimation,
  displayDuration: number,
  videoHeight: number,
  font?: FontName,
  fontColor: string = "#FFFFFF",
  shadowDepth: number = 2,
): Promise<void> {
  const { codec, presetFlags, qualityFlags } = getEncoder();

  const fontSize = Math.round(videoHeight / 6);
  const D        = displayDuration.toFixed(2);
  const yPct     = 0.10;

  const safeText = text
    .replace(/\\/g, "\\\\")   // \ → \\
    .replace(/'/g, "\\'")     // ' → \'
    .replace(/:/g, "\\:")     // : → \:
    .replace(/%/g, "%%");     // % → %%

  const fadeOut = `if(gt(t\\,${D}-0.3)\\,(${D}-t)/0.3\\,1)`;

  let alphaExpr: string;
  let yExpr = `h*${yPct}`;

  switch (animation) {
    case "fade":
      alphaExpr = `if(lt(t\\,0.5)\\,t/0.5\\,${fadeOut})`;
      break;
    case "pop":
      alphaExpr = `if(lt(t\\,0.12)\\,t/0.12\\,${fadeOut})`;
      break;
    case "slide":
      yExpr     = `if(lt(t\\,0.35)\\,h*${yPct}+h*0.05*(1-t/0.35)\\,h*${yPct})`;
      alphaExpr = fadeOut;
      break;
    default: // "none"
      alphaExpr = fadeOut;
  }

  const parts = [
    `drawtext=text='${safeText}'`,
    drawtextFontOpt(font),
    `fontsize=${fontSize}`,
    `x=(w-text_w)/2`,
    `y='${yExpr}'`,
    `fontcolor=${hexToDrawtextColor(fontColor)}`,
    `alpha='${alphaExpr}'`,
    `box=1`,
    `boxcolor=black@0.45`,
    `boxborderw=14`,
    `enable='lt(t\\,${D})'`,
  ];
  if (shadowDepth > 0) {
    parts.push(`shadowcolor=black@0.6`, `shadowx=${shadowDepth}`, `shadowy=${shadowDepth}`);
  }
  const vf = parts.join(":");

  await ffmpeg([
    "-i", inputPath,
    "-vf", vf,
    "-c:v", codec, ...presetFlags, ...qualityFlags(24),
    "-c:a", "copy",
    outputPath,
  ]);
}

// ── Beat-drop flash overlay ───────────────────────────────

/**
 * Apply a white-flash at each detected drop timestamp.
 *
 * Technique: FFmpeg timeline editing via the `enable` option on `eq`.
 * Each drop gets its own filter instance active for ±HALF_WIN seconds:
 *
 *   eq=brightness=0.75:saturation=0.35:enable='between(t,D-W,D+W)'
 *
 * The chain of N filters is comma-joined into a single -vf string —
 * no extra input streams, no complex filter_complex needed.
 * If there are no drops the input is stream-copied unchanged.
 */
export async function flashDropFrames(
  inputPath: string,
  outputPath: string,
  drops: number[],
): Promise<void> {
  if (drops.length === 0) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  const { codec, presetFlags, qualityFlags } = getEncoder();
  const HALF_WIN = 0.05; // ±50 ms = 100 ms flash window

  const vf = drops
    .map((d) => {
      const lo = (d - HALF_WIN).toFixed(3);
      const hi = (d + HALF_WIN).toFixed(3);
      // Single quotes protect the comma inside between() from the -vf chain parser
      return `eq=brightness=0.75:saturation=0.35:enable='between(t,${lo},${hi})'`;
    })
    .join(",");

  await ffmpeg([
    "-i", inputPath,
    "-vf", vf,
    "-c:v", codec, ...presetFlags, ...qualityFlags(22), "-an",
    outputPath,
  ]);
}

// ── Freeze-frame on drop ──────────────────────────────────
//
// At each detected music drop, holds the video on a single frozen frame for
// `freezeDur` seconds while flashing it bright-white for the first ~70 ms.
// Technique — single filter_complex pass:
//   1. split the input into 2N+1 streams (N normal segments + N freeze segments
//      + 1 trailing normal segment)
//   2. Normal segments: trim + setpts=PTS-STARTPTS  (original footage)
//   3. Freeze segments: trim one short window ≈ FRAME_GRAB seconds at the drop
//      → tpad=stop_mode=clone:stop_duration=FZ (clone last frame for FZ seconds)
//      → eq with brightness/saturation=near-zero for the first FLASH_DUR seconds
//   4. concat all segments in order: n0,f0,n1,f1,...,nN
//
// Result: at each drop the video freezes for FZ seconds with a white-flash punch.

export async function freezeFrameOnDrop(
  inputPath: string,
  outputPath: string,
  drops: number[],
  freezeDur = 0.28,
): Promise<void> {
  if (drops.length === 0) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  const FRAME_GRAB = 0.10; // capture 100 ms of source to feed tpad clone
  const FLASH_DUR  = 0.07; // 70 ms white-flash at freeze onset

  const sortedDrops = [...drops].sort((a, b) => a - b);
  const N = sortedDrops.length;
  const totalStreams = 2 * N + 1;

  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  // ── Split source into enough copies ──────────────────────
  const splitLabels = Array.from({ length: totalStreams }, (_, i) => `[s${i}]`).join("");
  filterParts.push(`[0:v]split=${totalStreams}${splitLabels}`);

  for (let i = 0; i <= N; i++) {
    const prevD = i === 0 ? null : sortedDrops[i - 1];
    const nextD = i === N ? null : sortedDrops[i];
    const streamIdx = i * 2;
    const nLabel = `n${i}`;

    // Normal segment: [prevD .. nextD)
    let trimOpts: string;
    if (prevD !== null && nextD !== null) {
      trimOpts = `trim=start=${prevD.toFixed(4)}:end=${nextD.toFixed(4)},setpts=PTS-STARTPTS`;
    } else if (prevD !== null) {
      trimOpts = `trim=start=${prevD.toFixed(4)},setpts=PTS-STARTPTS`;
    } else if (nextD !== null) {
      trimOpts = `trim=end=${nextD.toFixed(4)},setpts=PTS-STARTPTS`;
    } else {
      // Edge case: single-stream pass-through (0 drops, guarded above)
      trimOpts = "copy";
    }
    filterParts.push(`[s${streamIdx}]${trimOpts}[${nLabel}]`);
    concatInputs.push(`[${nLabel}]`);

    if (i < N) {
      // Freeze segment: grab FRAME_GRAB seconds at drop → clone last frame → flash
      const d = sortedDrops[i];
      const fLabel = `f${i}`;
      filterParts.push(
        `[s${streamIdx + 1}]` +
        `trim=start=${d.toFixed(4)}:end=${(d + FRAME_GRAB).toFixed(4)},` +
        `setpts=PTS-STARTPTS,` +
        `tpad=stop_mode=clone:stop_duration=${freezeDur.toFixed(3)},` +
        // bright-white desaturated flash for the first FLASH_DUR seconds,
        // then frozen frame returns to normal colour
        `eq=brightness=0.55:saturation=0.1:enable='lt(t,${FLASH_DUR.toFixed(3)})'` +
        `[${fLabel}]`,
      );
      concatInputs.push(`[${fLabel}]`);
    }
  }

  filterParts.push(
    `${concatInputs.join("")}concat=n=${2 * N + 1}:v=1[vout]`,
  );

  const { codec, presetFlags, qualityFlags } = getEncoder();
  await ffmpeg([
    "-i", inputPath,
    "-filter_complex", filterParts.join(";"),
    "-map", "[vout]",
    "-c:v", codec, ...presetFlags, ...qualityFlags(22), "-an",
    outputPath,
  ]);
}

// ── RGB glitch transition ─────────────────────────────────

const GLITCH_DUR_S = 0.08; // 80 ms chromatic flash at each cut

/**
 * Bake RGB chromatic-aberration glitch into the first 80 ms of a segment.
 *
 * Technique — geq pixel remapping:
 *   R channel: reads from (X + px, Y)   → shifts right
 *   G channel: reads from (X,      Y)   → unchanged (anchor)
 *   B channel: reads from (X − px, Y+2) → shifts left + slightly down
 * The three channel streams are then blended via addition to reconstruct
 * the image with the chromatic split visible at the cut point.
 *
 * Strategy (3-pass, avoids filter time-gating complexity):
 *   1. Extract first `glitchDur` seconds → apply RGB split → tmpA
 *   2. Stream-copy remainder              → tmpB
 *   3. Concat tmpA + tmpB                 → outputPath
 *
 * If the segment is shorter than 2 × glitchDur the whole segment gets
 * the effect (single-pass fallback) to avoid empty-file edge cases.
 */
export async function applyGlitchToStart(
  inputPath: string,
  outputPath: string,
  segDur: number,
  glitchDur = GLITCH_DUR_S,
): Promise<void> {
  const { codec, presetFlags, qualityFlags } = getEncoder();
  const px = 4; // pixel displacement per channel

  // filter_complex: split into R / G / B, remap coordinates, add back together.
  // Single quotes around geq expressions protect the commas from being parsed
  // as filter-chain separators when the string is passed directly via spawn().
  const rgbSplit = [
    "[0:v]split=3[r0][g0][b0]",
    `[r0]geq=r='r(X+${px},Y)':g=0:b=0[r1]`,
    `[g0]geq=r=0:g='g(X,Y)':b=0[g1]`,
    `[b0]geq=r=0:g=0:b='b(X-${px},Y+2)'[b1]`,
    "[r1][g1]blend=all_mode=addition[rg]",
    "[rg][b1]blend=all_mode=addition[out]",
  ].join(";");

  // Short-segment fallback — apply glitch to the full clip
  if (segDur <= glitchDur * 2) {
    await ffmpeg([
      "-i", inputPath,
      "-filter_complex", rgbSplit,
      "-map", "[out]",
      "-c:v", codec, ...presetFlags, ...qualityFlags(20), "-an",
      outputPath,
    ]);
    return;
  }

  const tmpA = outputPath + "_gp.mp4"; // glitch flash
  const tmpB = outputPath + "_cp.mp4"; // clean remainder
  const list = outputPath + "_gl.txt";

  try {
    // Pass 1 — glitch flash
    await ffmpeg([
      "-t", glitchDur.toFixed(3), "-i", inputPath,
      "-filter_complex", rgbSplit,
      "-map", "[out]",
      "-c:v", codec, ...presetFlags, ...qualityFlags(20), "-an",
      tmpA,
    ]);

    // Pass 2 — clean remainder (stream copy for speed)
    await ffmpeg([
      "-ss", glitchDur.toFixed(3), "-i", inputPath,
      "-c", "copy", "-an",
      tmpB,
    ]);

    // Pass 3 — stitch
    fs.writeFileSync(list, `file '${tmpA}'\nfile '${tmpB}'`, "utf8");
    await ffmpeg([
      "-f", "concat", "-safe", "0", "-i", list,
      "-c", "copy",
      outputPath,
    ]);
  } finally {
    for (const f of [tmpA, tmpB, list]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

export { path };
