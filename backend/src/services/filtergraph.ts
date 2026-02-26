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
}

export function buildClipFilter(opts: ClipFilterOptions): string {
  const { width, height, fps } = opts;
  const filters: string[] = [];

  // Base: crop to aspect ratio then scale
  filters.push(`crop=in_h*${width}/${height}:in_h`);
  filters.push(`scale=${width}:${height}`);
  filters.push(`fps=${fps}`);

  // Optional zoom punch — subtle animated zoom
  if (opts.zoomPunch) {
    // Use a shorter duration (d=1 frame) to keep the effect snappy per clip
    filters.push(
      `zoompan=z='if(lte(zoom\\,1.0)\\,1.06\\,max(1.0\\,zoom-0.006))':d=75:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`,
    );
  }

  // Optional speed variation — slight tempo changes between clips
  if (opts.speedVariation) {
    const idx = opts.segmentIndex ?? 0;
    // Alternate between slightly faster and slightly slower
    const pts = idx % 2 === 0 ? 0.92 : 1.08;
    filters.push(`setpts=${pts}*PTS`);
  }

  // Optional color grade
  if (opts.colorGrade) {
    const grade = colorGradeFilter(opts.colorGrade);
    if (grade) filters.push(grade);
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
    fade: "fade",
    glitch: "pixelize", // 'glitch' may not be available in all FFmpeg builds; pixelize is safe
    dissolve: "dissolve",
    wipeleft: "wipeleft",
    pixelize: "pixelize",
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

export { path };
