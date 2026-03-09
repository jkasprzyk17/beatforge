/**
 * Video assembly pipeline — preset-driven, modular.
 *
 * Flow:
 *   1. trimAndCrop()  × N   → one temp segment per beat (with preset filters)
 *   2. concatSegments/concatWithTransitions → stitched raw video
 *   3. muxAudio()            → add music track
 *   4. burnCaptions()        → ASS overlay
 *   5. extractThumbnail()    → JPEG at 1s
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getEncoder, type PlatformProfile } from "./platformProfiles.js";
import { type BeatResult } from "./beatDetection.js";
import { type Segment } from "./captions.js";
import { type PresetConfig, type HookAnimation, type Transition, SLOW_MOTION_KEYWORDS } from "./presetService.js";
import {
  buildClipFilter,
  concatSegments,
  concatWithTransitions,
  applyGlitchToStart,
  flashDropFrames,
  freezeFrameOnDrop,
  applyLetterbox,
  burnHookOverlay,
} from "./filtergraph.js";
import { subtitlesFontsDirOpt, FONTS_DIR } from "./fonts.js";
import type { FontName } from "./fonts.js";
import { buildFilterGraph } from "./compositionEngine.js";
import type { Composition } from "../types/composition.js";
import { getResolution } from "../types/composition.js";
import {
  getCachedClipMeta,
  saveClipMeta,
  type ClipMetaRecord,
} from "../utils/db.js";
import { DIRS, tmpSegmentPath, tmpConcatPath } from "../utils/helpers.js";

// ── FFmpeg runner ─────────────────────────────────────────

/**
 * Format a duration/timestamp (seconds) for FFmpeg -ss / -t arguments.
 *
 * JavaScript floating-point arithmetic can produce values like 1.78e-17 which
 * are semantically zero but String() serialises them in scientific notation.
 * FFmpeg rejects scientific notation for time specs, so we must use toFixed().
 * Six decimal places (≤ 1 µs precision) is more than sufficient for video work.
 *
 * Values below 1 µs are clamped to "0.000000" to avoid denormalised noise.
 */
function fmtTime(t: number): string {
  return Math.max(0, t).toFixed(6);
}

function ffmpeg(args: string[], cwd?: string): Promise<void> {
  // Quote args with space, " or : so log is copy-paste safe (colons like 0:v:0 can turn into emoji in some terminals)
  const fullCmd = ["ffmpeg", "-y", ...args]
    .map((a) => (a.includes(" ") || a.includes('"') || a.includes(":") ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");
  console.log("[ffmpeg] Full command:", fullCmd);
  if (cwd) console.log("[ffmpeg] cwd:", cwd);
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      ...(cwd ? { cwd } : {}),
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

// ── ffprobe with clip_metadata cache ─────────────────────
//
// probeClip() runs ffprobe once and stores the result in SQLite.
// On subsequent calls for the same file (same mtime), the DB row is returned
// immediately — no child process is spawned.
//
// getVideoDuration() is kept for backward compatibility; it is now a thin
// wrapper around probeClip().

async function ffprobeRaw(filePath: string): Promise<ClipMetaRecord> {
  const mtime = (() => {
    try { return Math.trunc(fs.statSync(filePath).mtimeMs); } catch { return 0; }
  })();

  return new Promise((resolve) => {
    let raw = "";
    const proc = spawn(
      "ffprobe",
      [
        "-v",           "quiet",
        "-show_entries", "format=duration:stream=width,height,r_frame_rate,codec_name",
        "-of",          "json",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    proc.stdout.on("data", (d: Buffer) => (raw += d.toString()));
    proc.on("close", () => {
      try {
        const j       = JSON.parse(raw);
        const duration = parseFloat(j.format?.duration ?? "0") || 0;
        const stream  = j.streams?.[0] ?? {};
        const width   = stream.width  != null ? Number(stream.width)  : undefined;
        const height  = stream.height != null ? Number(stream.height) : undefined;
        let   fps: number | undefined;
        if (stream.r_frame_rate) {
          const [n, d] = (stream.r_frame_rate as string).split("/").map(Number);
          if (d > 0) fps = n / d;
        }
        const codec = (stream.codec_name as string) || undefined;
        resolve({ path: filePath, mtime, duration, width, height, fps, codec });
      } catch {
        resolve({ path: filePath, mtime, duration: 0 });
      }
    });
    proc.on("error", () => resolve({ path: filePath, mtime, duration: 0 }));
  });
}

export async function probeClip(filePath: string): Promise<ClipMetaRecord> {
  let mtime = 0;
  try { mtime = Math.trunc(fs.statSync(filePath).mtimeMs); } catch {}

  if (mtime > 0) {
    const cached = getCachedClipMeta(filePath, mtime);
    if (cached) return cached;
  }

  const meta = await ffprobeRaw(filePath);

  if (meta.duration > 0) {
    try { saveClipMeta(meta); } catch { /* non-fatal */ }
  }

  return meta;
}

/** Backward-compatible wrapper — returns only duration. */
export async function getVideoDuration(filePath: string): Promise<number> {
  return (await probeClip(filePath)).duration;
}

// ── Step 1: trim + preset filters + crop a single segment ─

// ── Slow-motion keyword detector ──────────────────────────
//
// Returns true when any word inside a transcript segment that overlaps with
// the time window [cutTime, cutTime + cutDuration] matches a keyword.
//
// Matching is case-insensitive and strips non-alpha chars so "love," matches "love".

function hasSlowMotionKeyword(
  cutTime: number,
  cutDuration: number,
  segments: Segment[],
  keywords: string[],
): boolean {
  const kwSet = new Set(keywords.map((k) => k.toLowerCase()));
  const cutEnd = cutTime + cutDuration;

  for (const seg of segments) {
    // Overlap check: [seg.start, seg.end] ∩ [cutTime, cutEnd]
    if (seg.end < cutTime || seg.start > cutEnd) continue;

    const words = seg.text.toLowerCase().split(/\s+/);
    for (const w of words) {
      if (kwSet.has(w.replace(/[^a-z]/g, ""))) return true;
    }
  }
  return false;
}

// ── Step 2: trim, crop, filter one segment ────────────────

async function trimAndCrop(
  clipPath: string,
  start: number,
  duration: number,
  output: string,
  profile: PlatformProfile,
  preset: PresetConfig | null,
  segIndex: number,
  slowMotion = false,
): Promise<void> {
  const { codec, presetFlags, qualityFlags } = getEncoder();

  const zoomStrength = (preset as { _zoomPunchStrength?: number })?._zoomPunchStrength;
  const vf = buildClipFilter({
    width: profile.width,
    height: profile.height,
    fps: profile.fps,
    zoomPunch: preset?.zoomPunch ?? false,
    zoomPunchStrength: zoomStrength,
    speedVariation: preset?.speedVariation ?? false,
    colorGrade: preset?.colorGrade ?? null,
    segmentIndex: segIndex,
    filmGrain: preset?.filmGrain ?? false,
    vignette: preset?.vignette ?? false,
    slowMotion,
  });

  // When slow-motion is active the filter pipeline (minterpolate + setpts=2.0*PTS)
  // doubles the timestamps, so the output fills `duration` seconds even though
  // we only read `duration / 2` seconds of source footage.
  const inputDuration = slowMotion ? duration / 2 : duration;

  await ffmpeg([
    "-ss", fmtTime(start),
    "-t",  fmtTime(inputDuration),
    "-i",  clipPath,
    "-vf", vf,
    "-c:v", codec,
    ...presetFlags,
    ...qualityFlags(28),
    "-an",
    output,
  ]);
}

// ── Step 3: mux music over video ─────────────────────────

async function muxAudio(
  videoPath: string,
  musicPath: string,
  output: string,
  profile: PlatformProfile,
  duration: number,
): Promise<void> {
  const { codec, presetFlags, qualityFlags } = getEncoder();
  const q = profile.videoBitrate === "10M" ? 18 : 20;
  await ffmpeg([
    "-i", videoPath,
    "-i", musicPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", codec,
    ...presetFlags,
    ...qualityFlags(q),
    "-b:v", profile.videoBitrate,
    "-c:a", "aac",
    "-b:a", profile.audioBitrate,
    "-t",   String(duration),
    "-pix_fmt", "yuv420p",
    ...profile.extraFlags,
    output,
  ]);
}

// ── Step 4: burn ASS captions ─────────────────────────────

async function burnCaptions(
  videoPath: string,
  assPath: string,
  output: string,
): Promise<void> {
  const { codec, presetFlags, qualityFlags } = getEncoder();

  // Pass FFmpeg only the basename of the .ass file and set cwd to its directory.
  // This is the only reliable cross-platform approach — Windows drive-letter
  // colons in filtergraph option strings cause the subtitles filter to misparse
  // the path as `filename=C` + `original_size=/rest/of/path` regardless of
  // how the colon is escaped, because libass has its own option parser.
  const assDir  = path.dirname(path.resolve(assPath));
  const assFile = path.basename(assPath);

  const fontsDirOpt = subtitlesFontsDirOpt();
  const vfStr = `subtitles=${assFile}${fontsDirOpt}`;
  console.log(`[ass] burn: assPath=${assPath}, cwd=${assDir}, assFile=${assFile}, vf=${vfStr}`);

  await ffmpeg([
    "-i",   videoPath,
    "-vf",  vfStr,
    "-c:v", codec,
    ...presetFlags,
    ...qualityFlags(22),
    "-c:a", "copy",
    output,
  ], assDir);
}

// ── Step 5: thumbnail ─────────────────────────────────────

export async function extractThumbnail(
  videoPath: string,
  output: string,
): Promise<void> {
  await ffmpeg([
    "-i",
    videoPath,
    "-ss",
    "1",
    "-vframes",
    "1",
    "-q:v",
    "3",
    output,
  ]);
}

// ── Fisher-Yates shuffle (local, no deps) ─────────────────
//
// Kept inline so videoAssembler has zero new runtime dependencies.
// prng.ts provides the authoritative implementation for external callers.

function fisherYates<T>(arr: readonly T[], rng: RNG): T[] {
  const a = arr.slice() as T[];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/**
 * Build a sequence of `count` clip paths from `pool` with no consecutive repeat.
 * CapCut-style: the same clip never appears back-to-back, so each cut feels fresh.
 */
function buildClipSequenceNoRepeat(
  pool: string[],
  count: number,
  rng: RNG,
): string[] {
  if (pool.length === 0) return [];
  if (pool.length === 1) return Array.from({ length: count }, () => pool[0]!);

  const seq: string[] = [];
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      seq.push(pool[Math.floor(rng() * pool.length)]!);
      continue;
    }
    const prev = seq[i - 1]!;
    const others = pool.filter((c) => c !== prev);
    const clip = others[Math.floor(rng() * others.length)] ?? pool[i % pool.length]!;
    seq.push(clip);
  }
  return seq;
}

// ── Seeded PRNG (mulberry32) ──────────────────────────────
//
// Returns a drop-in replacement for Math.random() that produces a
// deterministic sequence for a given 32-bit integer seed.
// When seed is undefined the native Math.random is returned unchanged.
//
// Using mulberry32 — minimal state (4 bytes), good distribution, no deps.

type RNG = () => number;

function makePRNG(seed?: number): RNG {
  if (seed == null) return Math.random;
  let s = (seed | 0) >>> 0; // coerce to unsigned 32-bit
  return function (): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Build cut-point timeline ──────────────────────────────
//
// Beat strategy:
//   Uses beats.beats[] (actual onset timestamps from PCM analysis) as cut
//   points so every edit lands exactly on the music.  beatDivision (1|2|4)
//   subsamples to every 1st/2nd/4th beat for more cinematic phrasing (CapCut-style).
//   Falls back to uniform BPM math when there are fewer than 4 detected beats.
//
// Random strategy:
//   Variable 1.5–5 s segments for a more cinematic, less machine-gun feel.

interface CutPoint {
  time: number;     // seconds into the final video where this segment starts
  duration: number; // how long this segment should run
}

type BeatDivision = 1 | 2 | 4;

function buildCutPoints(
  beats: BeatResult,
  strategy: "beat" | "random",
  finalDuration: number,
  rng: RNG = Math.random,
  beatDivision: BeatDivision = 1,
): CutPoint[] {
  if (strategy === "beat" && beats.beats.length >= 4) {
    const validBeats = beats.beats.filter((t) => t < finalDuration);

    if (validBeats.length >= 2) {
      // Subsample to every Nth beat (1 = every beat, 2 = every 2nd, 4 = every 4th)
      // for more musical phrasing and less machine-gun cutting (CapCut-style).
      const step = Math.max(1, Math.min(4, beatDivision));
      const subsampled: number[] = [];
      for (let i = 0; i < validBeats.length; i += step) subsampled.push(validBeats[i]!);
      if (subsampled.length < 2) {
        return validBeats.slice(0, -1).map((t, i) => ({
          time: t,
          duration: Math.max(0.2, validBeats[i + 1]! - t),
        }));
      }
      return subsampled.slice(0, -1).map((t, i) => ({
        time: t,
        duration: Math.max(0.2, subsampled[i + 1]! - t),
      }));
    }
  }

  if (strategy === "beat") {
    // Fallback: uniform BPM-derived duration (original behaviour)
    const segDur = Math.max(0.5, 60 / (beats.bpm || 120));
    const count = Math.ceil(finalDuration / segDur);
    return Array.from({ length: count }, (_, i) => ({
      time: i * segDur,
      duration: segDur,
    }));
  }

  // Random strategy: variable 1.5–5 s cuts
  const points: CutPoint[] = [];
  let cursor = 0;
  while (cursor < finalDuration) {
    const dur = 1.5 + rng() * 3.5;
    const capped = Math.min(dur, finalDuration - cursor);
    if (capped < 0.5) break;
    points.push({ time: cursor, duration: capped });
    cursor += capped;
  }
  return points;
}

// Semi-pro edit: short intro (black) and outro (freeze last frame) so the edit doesn't start/end abruptly.
const INTRO_DURATION = 0.35;
const OUTRO_DURATION = 0.4;

async function createIntroSegment(
  outputPath: string,
  width: number,
  height: number,
  fps: number,
  duration: number,
): Promise<void> {
  const { codec, presetFlags, qualityFlags } = getEncoder();
  await ffmpeg([
    "-f", "lavfi",
    "-i", `color=c=black:s=${width}x${height}:r=${fps}`,
    "-t", fmtTime(duration),
    "-c:v", codec,
    ...presetFlags,
    ...qualityFlags(28),
    "-pix_fmt", "yuv420p",
    "-an",
    outputPath,
  ]);
}

async function createOutroFreeze(
  lastSegmentPath: string,
  outputPath: string,
  duration: number,
): Promise<void> {
  const { codec, presetFlags, qualityFlags } = getEncoder();
  await ffmpeg([
    "-sseof", "-0.001",
    "-i", lastSegmentPath,
    "-vf", `tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)}`,
    "-t", fmtTime(duration),
    "-c:v", codec,
    ...presetFlags,
    ...qualityFlags(28),
    "-pix_fmt", "yuv420p",
    "-an",
    outputPath,
  ]);
}

/** CapCut-style: stretch first and last segment by factor (e.g. 1.5) for softer intro/outro. */
function applyIntroOutroStretch(
  cutPoints: CutPoint[],
  factor: number,
): void {
  if (cutPoints.length < 3 || factor <= 1) return;
  const firstDur = cutPoints[0]!.duration;
  const lastDur = cutPoints[cutPoints.length - 1]!.duration;
  const addFirst = firstDur * (factor - 1);
  const addLast = lastDur * (factor - 1);
  // Steal from segment 1 for intro, from segment N-2 for outro
  if (cutPoints[1]!.duration > addFirst + 0.3 && cutPoints[cutPoints.length - 2]!.duration > addLast + 0.3) {
    cutPoints[0]!.duration = firstDur + addFirst;
    cutPoints[1]!.time += addFirst;
    cutPoints[1]!.duration -= addFirst;
    const lastIdx = cutPoints.length - 1;
    cutPoints[lastIdx]!.time -= addLast;
    cutPoints[lastIdx]!.duration += addLast;
    cutPoints[lastIdx - 1]!.duration -= addLast;
  }
}

// ── Main assemble parameters ──────────────────────────────

export interface AssembleParams {
  jobId: string;
  variant: number;
  clipPaths: string[];
  musicPath: string;
  beats: BeatResult;
  profile: PlatformProfile;
  finalDuration: number; // resolved by caller; never exceeds track duration
  preset: PresetConfig | null;
  segments?: Segment[];
  captionColor: string;
  outputPath: string;
  captionPath: string;       // .ass written by caller
  /** When true, do not burn captions into video; output video + separate .ass (soft subs). */
  captionsAsLayer?: boolean;
  hookText?: string;         // short overlay text (hook / CTA); omit to skip
  hookAnimation?: HookAnimation; // entrance animation for the hook text
  seed?: number;             // 32-bit integer — makes clip order + start positions reproducible
  composition?: Composition; // when set, use layer-based filter graph for final overlay
}

export async function assembleVideo(p: AssembleParams): Promise<void> {
  const {
    jobId,
    variant,
    clipPaths,
    musicPath,
    beats,
    profile,
    finalDuration,
    preset,
  } = p;

  fs.mkdirSync(DIRS.tmp, { recursive: true });
  fs.mkdirSync(DIRS.exports, { recursive: true });
  fs.mkdirSync(DIRS.thumbs, { recursive: true });

  // Seeded RNG — when p.seed is provided every random decision (clip order,
  // clip start offset, random cut durations) is fully reproducible.
  const rng = makePRNG(p.seed);

  // Determine cut strategy — energyBasedCuts forces beat mode
  const strategy: "beat" | "random" =
    preset?.energyBasedCuts || preset?.clipCutStrategy === "beat" ? "beat" : "random";

  const beatDivision: BeatDivision =
    (preset as { _beatDivision?: BeatDivision })?._beatDivision ?? 1;

  const contentDuration = Math.max(2, finalDuration - INTRO_DURATION - OUTRO_DURATION);

  const cutPoints = buildCutPoints(beats, strategy, contentDuration, rng, beatDivision);

  applyIntroOutroStretch(cutPoints, 1.5);

  // Fisher-Yates shuffle — zero bias.
  const shuffled = fisherYates(clipPaths, rng);

  // Clip sequence with no consecutive repeat (CapCut-style: same clip never back-to-back)
  const clipSequence = buildClipSequenceNoRepeat(shuffled, cutPoints.length, rng);

  const transition = preset?.transition ?? "none";
  let transitionsPerCut = (preset as { _transitions?: Transition[] })?._transitions ?? null;
  // Drop-aware: at cuts near a beat drop, use punchy transition (squeezev/zoomin)
  if (transitionsPerCut != null && transitionsPerCut.length > 0 && beats.drops.length > 0) {
    const DROP_WIN = 0.2;
    const punchy: Transition[] = ["squeezev", "zoomin"];
    transitionsPerCut = transitionsPerCut.map((t, i) => {
      const cutTime = cutPoints[i + 1]?.time ?? 0;
      const nearDrop = beats.drops.some((d) => Math.abs(d - cutTime) < DROP_WIN);
      return nearDrop ? punchy[Math.floor(rng() * punchy.length)]! : t;
    });
  }
  const tempFiles: string[] = [];
  const segDurations: number[] = [];

  // Resolve the keyword list once for the whole batch
  const slowKeywords = preset?.slowMotionKeywords ?? SLOW_MOTION_KEYWORDS;

  const MIN_SEG_DUR = 0.2;
  const MIN_CLIP_DUR = 0.5;

  for (let i = 0; i < cutPoints.length; i++) {
    const { time: cutTime, duration: segDur } = cutPoints[i];
    const prevClip = i > 0 ? clipSequence[i - 1] : null;
    const candidates =
      prevClip != null
        ? [clipSequence[i], ...shuffled.filter((c) => c !== clipSequence[i] && c !== prevClip)]
        : [clipSequence[i], ...shuffled.filter((c) => c !== clipSequence[i])];

    let clip = candidates[0]!;
    let clipDur = await getVideoDuration(clip);
    let actualSegDur = Math.min(segDur, clipDur - 0.1);

    for (let k = 1; k < candidates.length && (clipDur < MIN_CLIP_DUR || actualSegDur < MIN_SEG_DUR); k++) {
      const cand = candidates[k]!;
      const d = await getVideoDuration(cand);
      const a = Math.min(segDur, d - 0.1);
      if (d >= MIN_CLIP_DUR && a >= MIN_SEG_DUR) {
        clip = cand;
        clipDur = d;
        actualSegDur = a;
        break;
      }
      if (a > actualSegDur) {
        clip = cand;
        clipDur = d;
        actualSegDur = a;
      }
    }

    if (actualSegDur < MIN_SEG_DUR) {
      actualSegDur = Math.max(0.15, actualSegDur);
    }

    const out = tmpSegmentPath(`${jobId}_v${variant}`, i);

    // ── Slow-motion decision ──────────────────────────────
    const slowMotion =
      (preset?.slowMotion === true) && p.segments != null
        ? hasSlowMotionKeyword(cutTime, segDur, p.segments, slowKeywords)
        : false;

    const sourceDur = slowMotion ? actualSegDur / 2 : actualSegDur;
    const maxStart = Math.max(0, clipDur - sourceDur - 0.1);
    const start = maxStart > 0 ? rng() * maxStart : 0;

    tempFiles.push(out);
    segDurations.push(actualSegDur);

    await trimAndCrop(clip, start, actualSegDur, out, profile, preset, i, slowMotion);

    // glitch_rgb: bake RGB chromatic-aberration flash into the start of every
    // non-first segment so the effect fires exactly at each cut point.
    if (transition === "glitch_rgb" && i > 0) {
      const glitchOut = out + "_g.mp4";
      try {
        await applyGlitchToStart(out, glitchOut, actualSegDur);
        fs.unlinkSync(out);
        fs.renameSync(glitchOut, out);
      } catch {
        // Non-fatal — fall back to clean segment
        if (fs.existsSync(glitchOut)) fs.unlinkSync(glitchOut);
      }
    }
  }

  if (!tempFiles.length) throw new Error("No usable clip segments");

  const introPath = tmpConcatPath(`${jobId}_v${variant}_intro`);
  const outroPath = tmpConcatPath(`${jobId}_v${variant}_outro`);
  await createIntroSegment(introPath, profile.width, profile.height, profile.fps, INTRO_DURATION);
  await createOutroFreeze(tempFiles[tempFiles.length - 1]!, outroPath, OUTRO_DURATION);

  const concatOut = tmpConcatPath(`${jobId}_v${variant}`);
  const usePerCutTransitions =
    transitionsPerCut != null && transitionsPerCut.length === tempFiles.length - 1;

  if (!usePerCutTransitions && (transition === "glitch_rgb" || transition === "none")) {
    await concatSegments([introPath, ...tempFiles, outroPath], concatOut);
  } else {
    const contentPath = tmpConcatPath(`${jobId}_v${variant}_content`);
    const trans: Transition | Transition[] =
      usePerCutTransitions && transitionsPerCut != null ? transitionsPerCut : transition;
    await concatWithTransitions(tempFiles, segDurations, trans, contentPath);
    await concatSegments([introPath, contentPath, outroPath], concatOut);
    if (fs.existsSync(contentPath)) fs.unlinkSync(contentPath);
  }
  if (fs.existsSync(introPath)) fs.unlinkSync(introPath);
  if (fs.existsSync(outroPath)) fs.unlinkSync(outroPath);

  // If content was shorter than target (e.g. short clips), pad to finalDuration so video matches music length
  const concatDuration = await getVideoDuration(concatOut);
  if (concatDuration < finalDuration && concatDuration > 0) {
    const padDuration = finalDuration - concatDuration;
    const padPath = tmpConcatPath(`${jobId}_v${variant}_pad`);
    const paddedPath = tmpConcatPath(`${jobId}_v${variant}_padded`);
    try {
      await createOutroFreeze(concatOut, padPath, padDuration);
      await concatSegments([concatOut, padPath], paddedPath);
      fs.unlinkSync(concatOut);
      fs.unlinkSync(padPath);
      fs.renameSync(paddedPath, concatOut);
    } catch (e) {
      console.warn("[assembleVideo] Pad to finalDuration failed, keeping current length:", e);
      if (fs.existsSync(padPath)) fs.unlinkSync(padPath);
      if (fs.existsSync(paddedPath)) fs.unlinkSync(paddedPath);
    }
  }

  // Flash-frame overlay at detected drop timestamps (post-concat, pre-mux)
  if (preset?.flashOnDrop && beats.drops.length > 0) {
    const flashOut = concatOut + "_flash.mp4";
    try {
      await flashDropFrames(concatOut, flashOut, beats.drops);
      fs.unlinkSync(concatOut);
      fs.renameSync(flashOut, concatOut);
    } catch {
      // Non-fatal — continue without flash if FFmpeg fails
      if (fs.existsSync(flashOut)) fs.unlinkSync(flashOut);
    }
  }

  // Freeze-frame on drop — holds the video on a single frozen frame for ~0.28 s
  // with a bright-white flash at the drop, then resumes normal playback.
  // More dramatic than flashOnDrop; only applied when preset explicitly opts in.
  if (preset?.freezeOnDrop && beats.drops.length > 0) {
    // Guard: only process drops that fall within the video timeline
    const safeDrop = beats.drops.filter((d) => d > 0.3 && d < finalDuration - 0.5);
    if (safeDrop.length > 0) {
      const freezeOut = concatOut + "_freeze.mp4";
      try {
        await freezeFrameOnDrop(concatOut, freezeOut, safeDrop);
        fs.unlinkSync(concatOut);
        fs.renameSync(freezeOut, concatOut);
      } catch {
        // Non-fatal — fall back to video without freeze effect
        if (fs.existsSync(freezeOut)) fs.unlinkSync(freezeOut);
      }
    }
  }

  // Letterbox bars — applied before mux so captions/hook render on top of bars
  if (preset?.letterbox && !p.composition) {
    const lbOut = concatOut + "_lb.mp4";
    try {
      await applyLetterbox(concatOut, lbOut);
      fs.unlinkSync(concatOut);
      fs.renameSync(lbOut, concatOut);
    } catch {
      if (fs.existsSync(lbOut)) fs.unlinkSync(lbOut);
    }
  }

  // Video length can be slightly less than finalDuration (e.g. only short clips in pool). Mux audio to actual video length so no trailing audio.
  const actualVideoDuration = await getVideoDuration(concatOut);
  const muxDuration = actualVideoDuration > 0 ? Math.min(actualVideoDuration, finalDuration) : finalDuration;

  // ── Composition path: single FFmpeg pass (scale + all layers + mux) ─────
  if (p.composition) {
    const is1_1Letterbox = p.composition.outputDisplayMode === "1:1_letterbox";
    const contentRes = is1_1Letterbox
      ? getResolution("1:1")
      : getResolution(p.composition.aspectRatio);
    const outputRes = is1_1Letterbox
      ? getResolution("9:16")
      : contentRes;
    const { width, height } = contentRes;
    const { width: outW, height: outH } = outputRes;
    const assDir = path.dirname(path.resolve(p.captionPath));
    const vf = buildFilterGraph(p.composition, {
      width,
      height,
      ...(is1_1Letterbox ? { outputWidth: outW, outputHeight: outH } : {}),
      assPath: !p.captionsAsLayer && fs.existsSync(p.captionPath) ? p.captionPath : undefined,
      assDir,
      fontsDir: FONTS_DIR,
      hookText: p.hookText,
      hookAnimation: p.hookAnimation ?? "fade",
      font: preset?.captionFont as FontName | undefined,
      fps: profile.fps,
    });
    const { codec, presetFlags, qualityFlags } = getEncoder();
    const q = profile.videoBitrate === "10M" ? 18 : 20;
    await ffmpeg(
      [
        "-i", concatOut,
        "-i", musicPath,
        "-vf", vf,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", codec,
        ...presetFlags,
        ...qualityFlags(q),
        "-b:v", profile.videoBitrate,
        "-c:a", "aac",
        "-b:a", profile.audioBitrate,
        "-t", fmtTime(muxDuration),
        "-pix_fmt", "yuv420p",
        ...profile.extraFlags,
        p.outputPath,
      ],
      assDir,
    );
  } else {
    const muxedOut = p.outputPath + "_premux.mp4";
    await muxAudio(concatOut, musicPath, muxedOut, profile, muxDuration);

    // Burn captions or just rename (when captionsAsLayer: true, keep video without burn; .ass stays separate)
    if (p.segments && p.segments.length > 0 && !p.captionsAsLayer) {
      if (fs.existsSync(p.captionPath)) {
        await burnCaptions(muxedOut, p.captionPath, p.outputPath);
        fs.unlinkSync(muxedOut);
      } else {
        console.warn(
          `[assembleVideo] Captions skipped: .ass file missing (${p.captionPath}). Segments: ${p.segments.length}. Check that generate wrote the file.`,
        );
        fs.renameSync(muxedOut, p.outputPath);
      }
    } else {
      fs.renameSync(muxedOut, p.outputPath);
    }

    // Hook text overlay — burns last so it sits above captions
    if (p.hookText) {
      const hookOut = p.outputPath + "_hook.mp4";
      try {
        await burnHookOverlay(
          p.outputPath,
          hookOut,
          p.hookText,
          p.hookAnimation ?? "fade",
          3.0,
          profile.height,
          preset?.captionFont,
        );
        fs.unlinkSync(p.outputPath);
        fs.renameSync(hookOut, p.outputPath);
      } catch {
        if (fs.existsSync(hookOut)) fs.unlinkSync(hookOut);
      }
    }
  }

  // Cleanup temp segments
  for (const f of [...tempFiles, concatOut]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// ── Preview (low-res, quick) ──────────────────────────────

export async function assemblePreview(
  clipPaths: string[],
  musicPath: string,
  beats: BeatResult,
  previewDur: number,
  outputPath: string,
): Promise<void> {
  if (!clipPaths.length) throw new Error("No clips provided");

  fs.mkdirSync(DIRS.tmp, { recursive: true });
  fs.mkdirSync(DIRS.exports, { recursive: true });

  const segDur = Math.max(1, 60 / (beats.bpm || 120));
  const segCount = Math.ceil(previewDur / segDur);
  const tmpSegs: string[] = [];
  const jobId = "preview_" + Date.now();

  for (let i = 0; i < segCount; i++) {
    const clip = clipPaths[i % clipPaths.length];
    const clipDur = await getVideoDuration(clip);
    if (clipDur < 0.5) continue;
    const start = Math.random() * Math.max(0, clipDur - segDur - 0.1);
    const out = tmpSegmentPath(jobId, i);
    tmpSegs.push(out);

    const vf = buildClipFilter({ width: 720, height: 1280, fps: 30 });
    const { codec, presetFlags, qualityFlags } = getEncoder();
    const { spawn: sp } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      const proc = sp(
        "ffmpeg",
        [
          "-y",
          "-ss", fmtTime(start),
          "-t",  fmtTime(segDur),
          "-i",  clip,
          "-vf", vf,
          "-c:v", codec,
          ...presetFlags,
          ...qualityFlags(32),
          "-an",
          out,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const err: string[] = [];
      proc.stderr.on("data", (d: Buffer) => err.push(d.toString()));
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(err.slice(-5).join(""))),
      );
      proc.on("error", reject);
    });
  }

  if (!tmpSegs.length) throw new Error("No usable clips for preview");

  const concat = tmpConcatPath(jobId);
  await concatSegments(tmpSegs, concat);

  const previewProfile: PlatformProfile = {
    id: "tiktok",
    label: "Preview",
    emoji: "▶",
    width: 720,
    height: 1280,
    maxDuration: previewDur,
    defaultDuration: previewDur,
    fps: 30,
    videoBitrate: "4M",
    audioBitrate: "128k",
    captionMarginBottom: 120,
    captionMarginSide: 20,
    captionStyle: "bold_center",
    extraFlags: [],
  };
  await muxAudio(concat, musicPath, outputPath, previewProfile, previewDur);

  for (const f of [...tmpSegs, concat]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}
