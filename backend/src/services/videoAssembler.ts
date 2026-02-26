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
import { type PresetConfig, type HookAnimation, SLOW_MOTION_KEYWORDS } from "./presetService.js";
import {
  buildClipFilter,
  concatSegments,
  concatWithTransitions,
  applyGlitchToStart,
  flashDropFrames,
  applyLetterbox,
  burnHookOverlay,
} from "./filtergraph.js";
import { subtitlesFontsDirOpt } from "./fonts.js";
import {
  getCachedClipMeta,
  saveClipMeta,
  type ClipMetaRecord,
} from "../utils/db.js";
import { DIRS, tmpSegmentPath, tmpConcatPath } from "../utils/helpers.js";

// ── FFmpeg runner ─────────────────────────────────────────

function ffmpeg(args: string[], cwd?: string): Promise<void> {
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

  const vf = buildClipFilter({
    width: profile.width,
    height: profile.height,
    fps: profile.fps,
    zoomPunch: preset?.zoomPunch ?? false,
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
    "-ss", String(start),
    "-t",  String(inputDuration),
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

  // Append `:fontsdir=…` when bundled fonts are present so libass can locate
  // Oswald / Montserrat TTFs without them being system-installed.
  // subtitlesFontsDirOpt() returns "" when the fonts dir is empty or absent.
  const fontsDirOpt = subtitlesFontsDirOpt();

  await ffmpeg([
    "-i",   videoPath,
    "-vf",  `subtitles=${assFile}${fontsDirOpt}`,
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
//   points so every edit lands exactly on the music.  Falls back to uniform
//   BPM math when there are fewer than 4 detected beats (e.g. silent track).
//
// Random strategy:
//   Variable 1.5–5 s segments for a more cinematic, less machine-gun feel.

interface CutPoint {
  time: number;     // seconds into the final video where this segment starts
  duration: number; // how long this segment should run
}

function buildCutPoints(
  beats: BeatResult,
  strategy: "beat" | "random",
  finalDuration: number,
  rng: RNG = Math.random,
): CutPoint[] {
  if (strategy === "beat" && beats.beats.length >= 4) {
    // Filter to beats that fall within the video window
    const validBeats = beats.beats.filter((t) => t < finalDuration);

    if (validBeats.length >= 2) {
      return validBeats.slice(0, -1).map((t, i) => ({
        time: t,
        duration: Math.max(0.2, validBeats[i + 1] - t),
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
  hookText?: string;         // short overlay text (hook / CTA); omit to skip
  hookAnimation?: HookAnimation; // entrance animation for the hook text
  seed?: number;             // 32-bit integer — makes clip order + start positions reproducible
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

  // Build cut-point timeline from actual beat timestamps when available,
  // otherwise fall back to uniform BPM math or random intervals.
  const cutPoints = buildCutPoints(beats, strategy, finalDuration, rng);

  // Fisher-Yates shuffle — zero bias.
  // The previous .sort(() => rng() - 0.5) produced biased permutations:
  // quicksort's pivot selection interacts with the comparator, causing some
  // permutations to appear up to 3× more often than others for small arrays.
  const shuffled = fisherYates(clipPaths, rng);

  const transition = preset?.transition ?? "none";
  const tempFiles: string[] = [];
  const segDurations: number[] = [];

  // Resolve the keyword list once for the whole batch
  const slowKeywords = preset?.slowMotionKeywords ?? SLOW_MOTION_KEYWORDS;

  for (let i = 0; i < cutPoints.length; i++) {
    const { time: cutTime, duration: segDur } = cutPoints[i];
    const clip = shuffled[i % shuffled.length];
    const clipDur = await getVideoDuration(clip);
    if (clipDur < 0.5) continue;

    const actualSegDur = Math.min(segDur, clipDur - 0.1);
    if (actualSegDur < 0.2) continue;

    // ── Slow-motion decision ──────────────────────────────
    // Applies when: preset enables slowMotion AND segments are available AND
    // the current cut-point's time window contains a slow-mo keyword in the lyrics.
    // minterpolate + setpts=2.0 means we only need half the source footage.
    const slowMotion =
      (preset?.slowMotion === true) && p.segments != null
        ? hasSlowMotionKeyword(cutTime, segDur, p.segments, slowKeywords)
        : false;

    // When slow-mo is active, only half the source clip duration is consumed.
    const sourceDur = slowMotion ? actualSegDur / 2 : actualSegDur;
    const maxStart = Math.max(0, clipDur - sourceDur - 0.1);
    const start = rng() * maxStart;
    const out = tmpSegmentPath(`${jobId}_v${variant}`, i);

    tempFiles.push(out);
    segDurations.push(actualSegDur); // output duration unchanged

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

  // Concat — glitch_rgb has the effect baked in so it uses simple concat;
  // all other named transitions go through the xfade pipeline.
  const concatOut = tmpConcatPath(`${jobId}_v${variant}`);

  if (transition === "glitch_rgb" || transition === "none") {
    await concatSegments(tempFiles, concatOut);
  } else {
    await concatWithTransitions(tempFiles, segDurations, transition, concatOut);
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

  // Letterbox bars — applied before mux so captions/hook render on top of bars
  if (preset?.letterbox) {
    const lbOut = concatOut + "_lb.mp4";
    try {
      await applyLetterbox(concatOut, lbOut);
      fs.unlinkSync(concatOut);
      fs.renameSync(lbOut, concatOut);
    } catch {
      if (fs.existsSync(lbOut)) fs.unlinkSync(lbOut);
    }
  }

  // Mux audio
  const muxedOut = p.outputPath + "_premux.mp4";
  await muxAudio(concatOut, musicPath, muxedOut, profile, finalDuration);

  // Burn captions or just rename
  if (p.segments && p.segments.length > 0 && fs.existsSync(p.captionPath)) {
    await burnCaptions(muxedOut, p.captionPath, p.outputPath);
    fs.unlinkSync(muxedOut);
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
      // Non-fatal — video is still usable without the hook overlay
      if (fs.existsSync(hookOut)) fs.unlinkSync(hookOut);
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
          "-ss", String(start),
          "-t",  String(segDur),
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
