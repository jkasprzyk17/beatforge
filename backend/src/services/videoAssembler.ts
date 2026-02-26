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
import { type PresetConfig } from "./presetService.js";
import {
  buildClipFilter,
  concatSegments,
  concatWithTransitions,
} from "./filtergraph.js";
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

// ── ffprobe: get video/audio duration ────────────────────

export async function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    let out = "";
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.on("close", () => resolve(parseFloat(out) || 0));
    proc.on("error", () => resolve(0));
  });
}

// ── Step 1: trim + preset filters + crop a single segment ─

async function trimAndCrop(
  clipPath: string,
  start: number,
  duration: number,
  output: string,
  profile: PlatformProfile,
  preset: PresetConfig | null,
  segIndex: number,
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
  });

  await ffmpeg([
    "-ss", String(start),
    "-t",  String(duration),
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

  await ffmpeg([
    "-i",   videoPath,
    "-vf",  `subtitles=${assFile}`,
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
    const dur = 1.5 + Math.random() * 3.5;
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
  captionPath: string; // .ass written by caller
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

  // Determine cut strategy — energyBasedCuts forces beat mode
  const strategy: "beat" | "random" =
    preset?.energyBasedCuts || preset?.clipCutStrategy === "beat" ? "beat" : "random";

  // Build cut-point timeline from actual beat timestamps when available,
  // otherwise fall back to uniform BPM math or random intervals.
  const cutPoints = buildCutPoints(beats, strategy, finalDuration);

  // Shuffle clips cyclically
  const shuffled = [...clipPaths].sort(() => Math.random() - 0.5);

  const tempFiles: string[] = [];
  const segDurations: number[] = [];

  for (let i = 0; i < cutPoints.length; i++) {
    const { duration: segDur } = cutPoints[i];
    const clip = shuffled[i % shuffled.length];
    const clipDur = await getVideoDuration(clip);
    if (clipDur < 0.5) continue;

    const actualSegDur = Math.min(segDur, clipDur - 0.1);
    if (actualSegDur < 0.2) continue;

    const maxStart = Math.max(0, clipDur - actualSegDur - 0.1);
    const start = Math.random() * maxStart;
    const out = tmpSegmentPath(`${jobId}_v${variant}`, i);

    tempFiles.push(out);
    segDurations.push(actualSegDur);

    await trimAndCrop(clip, start, actualSegDur, out, profile, preset, i);
  }

  if (!tempFiles.length) throw new Error("No usable clip segments");

  // Concat — with or without transitions
  const concatOut = tmpConcatPath(`${jobId}_v${variant}`);
  const transition = preset?.transition ?? "none";

  if (transition !== "none") {
    await concatWithTransitions(tempFiles, segDurations, transition, concatOut);
  } else {
    await concatSegments(tempFiles, concatOut);
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
