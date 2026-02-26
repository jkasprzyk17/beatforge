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
import type { ColorGrade, Transition } from "./presetService.js";

// ── FFmpeg runner ─────────────────────────────────────────

function ffmpeg(args: string[]): Promise<void> {
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

// ── Build per-clip video filter ───────────────────────────

export interface ClipFilterOptions {
  width: number;
  height: number;
  fps: number;
  zoomPunch?: boolean;
  speedVariation?: boolean;
  colorGrade?: ColorGrade;
  segmentIndex?: number; // used to vary speed per segment
  filmGrain?: boolean;   // adds subtle temporal noise (alls=8, allf=t+u)
  vignette?: boolean;    // adds edge-darkening lens vignette (angle PI/5)
}

export function buildClipFilter(opts: ClipFilterOptions): string {
  const { width, height, fps } = opts;
  const filters: string[] = [];

  // Base: crop to aspect ratio then scale
  filters.push(`crop=in_h*${width}/${height}:in_h`);
  filters.push(`scale=${width}:${height}`);
  filters.push(`fps=${fps}`);

  // Zoom punch — snaps to 1.08× on frame 1, decays ~0.03/frame back to 1.0.
  // d=1 means one output frame per input frame (no buffering delay).
  // The old d=75 caused a ~2.5 s output stall and a continuous oscillation.
  if (opts.zoomPunch) {
    filters.push(
      `zoompan=z='if(eq(on\\,1)\\,1.08\\,max(1.0\\,zoom-0.03))':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`,
    );
  }

  // Optional speed variation — slight tempo changes between clips.
  // Even-indexed segments run at 0.92× (8% faster); odd at 1.08× (8% slower).
  if (opts.speedVariation) {
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

export async function concatWithTransitions(
  segments: string[],
  durations: number[],
  transition: Transition,
  output: string,
): Promise<void> {
  if (segments.length === 0) throw new Error("No segments to concat");
  if (segments.length === 1) {
    fs.copyFileSync(segments[0], output);
    return;
  }

  // Fall back to simple concat for unsupported/none transition
  if (transition === "none") {
    return concatSegments(segments, output);
  }

  const { codec, presetFlags, qualityFlags } = getEncoder();
  const xfadeDur = 0.08; // 80ms cross-fade — fast and snappy

  // Map our transition names to FFmpeg xfade transition names
  const xfadeMap: Record<string, string> = {
    fade:     "fade",
    glitch:   "pixelize",  // true RGB glitch is a future filtergraph; pixelize is safe fallback
    dissolve: "dissolve",
    wipeleft: "wipeleft",
    pixelize: "pixelize",
    squeezev: "squeezev",  // vertical squeeze-in — punchy, great on beat drops
    zoomin:   "zoomin",    // zoom-in wipe — smooth and modern
    hblur:    "hblur",     // horizontal blur smear — fast & cinematic
  };
  const xfadeName = xfadeMap[transition] ?? "fade";

  // Build filter_complex for N inputs with N-1 xfades
  // Offset of xfade i = sum(durations[0..i]) - xfadeDur * (i + 1)
  const inputs = segments.flatMap((s) => ["-i", s]);

  let filter = "";
  let prevLabel = "[0:v]";
  let cumulativeDur = 0;

  for (let i = 1; i < segments.length; i++) {
    cumulativeDur += durations[i - 1];
    const offset = Math.max(0, cumulativeDur - xfadeDur * i);
    const outLabel = i === segments.length - 1 ? "[vout]" : `[v${i}]`;

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
