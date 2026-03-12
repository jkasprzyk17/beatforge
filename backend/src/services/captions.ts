/**
 * Local Whisper transcription via @xenova/transformers.
 * No Python, no API key — model downloads once to ~/.cache/huggingface.
 *
 * Also generates SRT subtitle files from segments.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getDataDir } from "../utils/helpers.js";

export interface Segment {
  start: number;
  end: number;
  text: string;
  word?: boolean; // true when this is a single word (word-level mode)
}

// ── Lazy-load Whisper pipeline (ESM dynamic import) ───────

let _pipe:
  | ((audio: string | Float32Array, opts?: object) => Promise<WhisperResult>)
  | null = null;
let _lock: Promise<void> | null = null; // mutex — prevent parallel Whisper calls

interface WhisperChunk {
  timestamp: [number, number | null];
  text: string;
}
interface WhisperResult {
  text: string;
  chunks?: WhisperChunk[];
}

// Map short model names → full HuggingFace model IDs
// onnx-community has quantized ONNX exports for large models
function resolveModelId(name: string): string {
  const MAP: Record<string, string> = {
    tiny: "Xenova/whisper-tiny",
    base: "Xenova/whisper-base",
    small: "Xenova/whisper-small",
    medium: "Xenova/whisper-medium",
    large: "Xenova/whisper-large-v2",
    "large-v2": "Xenova/whisper-large-v2",
    "large-v3": "Xenova/whisper-large-v3",
    "large-v3-turbo": "onnx-community/whisper-large-v3-turbo",
    turbo: "onnx-community/whisper-large-v3-turbo",
  };
  return MAP[name] ?? `Xenova/whisper-${name}`;
}

async function getWhisperPipe() {
  if (_pipe) return _pipe;

  const { pipeline, env } = await import("@huggingface/transformers");

  env.cacheDir = path.join(getDataDir(), ".whisper-cache");
  env.allowLocalModels = false;

  const modelName = process.env.WHISPER_MODEL ?? "large-v3-turbo";
  const modelId = resolveModelId(modelName);
  console.log(`[captions] Loading Whisper model: ${modelId}`);

  // q4 = 4-bit quantized ONNX — ~4x faster than fp32, minimal quality loss
  _pipe = (await pipeline("automatic-speech-recognition", modelId, {
    dtype: "q4" as never,
  })) as unknown as typeof _pipe;
  return _pipe!;
}

// ── Decode audio → Float32Array @ 16kHz via ffmpeg pipe ──────────
// Whisper REQUIRES exactly 16kHz mono — ffmpeg guarantees it.
// Much more reliable than any Node.js audio decoder for resampling.

function decodeAudioFile(filePath: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(
      "ffmpeg",
      [
        "-i",
        filePath,
        // Vocal-band EQ: cut bass/hiss, normalize loudness without clipping
        "-af",
        "highpass=f=150,lowpass=f=4000,dynaudnorm=f=150:g=15",
        "-f",
        "f32le", // raw float32 little-endian
        "-ac",
        "1", // mono
        "-ar",
        "16000", // 16kHz — exactly what Whisper expects
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.on("close", (code) => {
      if (code !== 0 && chunks.length === 0) {
        return reject(new Error(`ffmpeg audio decode failed (code ${code})`));
      }
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    });
    proc.on("error", (err) =>
      reject(
        new Error(
          `ffmpeg not found: ${err.message}. Install with: brew install ffmpeg`,
        ),
      ),
    );
  });
}

// ── Word-approximate: split segment timestamps evenly across words ──
// Used as fallback when the model doesn't support true word timestamps

export function segmentsToWords(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const ws = seg.text.trim().split(/\s+/).filter(Boolean);
    if (!ws.length) continue;
    const dur = (seg.end - seg.start) / ws.length;
    ws.forEach((word, i) =>
      out.push({
        start: +(seg.start + i * dur).toFixed(2),
        end: +(seg.start + (i + 1) * dur).toFixed(2),
        text: word,
        word: true,
      }),
    );
  }
  return out;
}

// ── Whisper noise/music tokens to discard ─────────────────
// Whisper emits these when it hears music without clear speech.
const NOISE_TOKENS =
  /^\s*\[?(muzyka|music|applause|laughter|noise|inaudible|silence|śmiech|oklaski|cisza)\]?\s*$/i;

function parseResult(result: WhisperResult): Segment[] {
  if (result.chunks && result.chunks.length > 0) {
    const segments = result.chunks
      .map((c, i, arr) => ({
        start: c.timestamp[0],
        // If end is null (last word), estimate from next word or +0.4s
        end: c.timestamp[1] ?? arr[i + 1]?.timestamp[0] ?? c.timestamp[0] + 0.4,
        text: c.text.trim(),
        word: true,
      }))
      .filter((s) => s.text.length > 0 && !NOISE_TOKENS.test(s.text));
    return segments;
  }
  const text = result.text?.trim();
  if (!text || NOISE_TOKENS.test(text)) return [];
  return [{ start: 0, end: 999, text }];
}

// ── Public: transcribe a file → segments ─────────────────

export async function transcribeAudio(audioPath: string): Promise<Segment[]> {
  // Mutex: queue calls, never run Whisper in parallel
  while (_lock) {
    console.log("[captions] waiting for previous transcription to finish…");
    await _lock;
  }

  let resolve!: () => void;
  _lock = new Promise((r) => {
    resolve = r;
  });

  try {
    console.log("[captions] decoding audio via ffmpeg →", audioPath);
    const audio = await decodeAudioFile(audioPath);
    console.log(
      `[captions] decoded ${audio.length} samples @ 16kHz (${(audio.length / 16000).toFixed(1)}s) — running Whisper…`,
    );

    const pipe = await getWhisperPipe();
    const opts = {
      chunk_length_s: 30,
      stride_length_s: 5,
      language: (process.env.WHISPER_LANGUAGE === "auto"
        ? null
        : (process.env.WHISPER_LANGUAGE ?? "pl")) as string,
      no_speech_threshold: 0.1,
      condition_on_previous_text: false,
    };

    // Try true word-level timestamps first
    try {
      const result = (await pipe(audio, {
        ...opts,
        return_timestamps: "word",
      })) as WhisperResult;
      console.log(
        `[captions] word-level raw text: "${result.text?.slice(0, 120)}"`,
      );
      const segs = parseResult(result);
      console.log(`[captions] → ${segs.length} word(s)`);
      return segs;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!msg.includes("cross attentions")) throw e;
      // Model doesn't have attention weights (e.g. q4 quantized) —
      // fall back to segment timestamps, then split evenly into words
      console.warn(
        "[captions] model lacks cross-attentions for word timestamps — falling back to segment split",
      );
    }

    const result = (await pipe(audio, {
      ...opts,
      return_timestamps: true,
    })) as WhisperResult;
    console.log(`[captions] segment raw text: "${result.text?.slice(0, 120)}"`);
    const segs = parseResult(result);
    const words = segmentsToWords(segs);
    console.log(
      `[captions] → ${segs.length} segment(s) → ${words.length} approximate word(s)`,
    );
    return words;
  } finally {
    _lock = null;
    resolve();
  }
}

// ── SRT helpers ───────────────────────────────────────────

function toSrtTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.round((secs % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function buildSrt(segments: Segment[]): string {
  return segments
    .map(
      (seg, i) =>
        `${i + 1}\n${toSrtTime(seg.start)} --> ${toSrtTime(seg.end)}\n${seg.text}`,
    )
    .join("\n\n");
}

/** Group word-level segments into readable subtitle lines (N words at a time). */
export function buildSrtGrouped(segments: Segment[], wordsPerLine = 4): string {
  if (!segments.length) return "";
  // If these are not word-level segments, fall back to standard SRT
  if (!segments[0].word) return buildSrt(segments);

  const lines = groupWordsIntoLines(segments, wordsPerLine, 0.5);
  return lines
    .map((line, i) => {
      const text = line.map((w) => w.text).join(" ");
      return `${i + 1}\n${toSrtTime(line[0].start)} --> ${toSrtTime(line[line.length - 1].end)}\n${text}`;
    })
    .join("\n\n");
}

export function writeSrt(segments: Segment[], srtPath: string): void {
  fs.writeFileSync(srtPath, buildSrt(segments), "utf8");
}

// ── ASS caption animation ─────────────────────────────────────────────────
//
// Inline override tags prepended to each Dialogue text field.
//
// "pop"       — scales from 0 → 130 % → 95 % → 100 % in 320 ms (TikTok-style).
// "bounce"    — springs to 112 % → 97 % → 100 % in 300 ms.
// "fade"      — alpha fade-in / fade-out.
// "scale_in"  — softer scale 80 % → 100 % in 240 ms (semi-pro, less punchy).
// "slide_up"  — text slides up from slightly below (needs geometry for \\pos).
// "none"      — no tag.
//

export type CaptionAnimation =
  | "none"
  | "pop"
  | "bounce"
  | "fade"
  | "scale_in"
  | "slide_up";

/** Optional geometry for position-dependent animations (e.g. slide_up). */
export interface AnimationGeometry {
  width: number;
  height: number;
  marginBottom: number;
  alignment: number; // 2 = bottom center, 5 = middle center
}

/** Optional custom fade durations (ms). ASS \\fad uses centiseconds. */
export interface FadeOverrides {
  fadeInMs?: number;
  fadeOutMs?: number;
}

/**
 * Returns the ASS inline-override tag string for the given animation.
 * @param anim     Animation type.
 * @param short    Shorter timing for per-word (pill) events.
 * @param geometry When set, used for slide_up to compute start/end position.
 * @param fade     When set and anim is "fade", use custom \\fad(fadeInCs, fadeOutCs).
 */
export function animationTag(
  anim: CaptionAnimation | undefined,
  short = false,
  geometry?: AnimationGeometry,
  fade?: FadeOverrides,
): string {
  if (anim === "fade" && (fade?.fadeInMs != null || fade?.fadeOutMs != null)) {
    const inCs = Math.max(0, Math.round((fade.fadeInMs ?? (short ? 60 : 180)) / 10));
    const outCs = Math.max(0, Math.round((fade.fadeOutMs ?? (short ? 40 : 100)) / 10));
    return `{\\fad(${inCs},${outCs})}`;
  }
  switch (anim) {
    case "pop":
      return short
        ? "{\\fscx0\\fscy0\\t(0,80,\\fscx120\\fscy120)\\t(80,160,\\fscx100\\fscy100)}"
        : "{\\fscx0\\fscy0\\t(0,120,\\fscx130\\fscy130)\\t(120,220,\\fscx95\\fscy95)\\t(220,320,\\fscx100\\fscy100)}";
    case "bounce":
      return short
        ? "{\\t(0,80,\\fscx112\\fscy112)\\t(80,160,\\fscx100\\fscy100)}"
        : "{\\t(0,100,\\fscx112\\fscy112)\\t(100,210,\\fscx97\\fscy97)\\t(210,300,\\fscx100\\fscy100)}";
    case "fade":
      return short
        ? "{\\fad(60,40)}"
        : "{\\fad(180,100)}";
    case "scale_in":
      return short
        ? "{\\fscx80\\fscy80\\t(0,100,\\fscx100\\fscy100)}"
        : "{\\fscx80\\fscy80\\t(0,240,\\fscx100\\fscy100)}";
    case "slide_up":
      if (geometry) {
        const cx = Math.round(geometry.width / 2);
        const cy =
          geometry.alignment === 5
            ? Math.round(geometry.height / 2)
            : geometry.height - geometry.marginBottom;
        const fromY = Math.min(geometry.height - 20, cy + 70);
        return `{\\pos(${cx},${fromY})\\t(0,220,\\pos(${cx},${cy}))}`;
      }
      return "{\\fad(120,100)}";
    default:
      return "";
  }
}

/** Content only (no outer braces) for enter animation. Used with combinedAnimationTag. */
function animationEnterContent(
  anim: CaptionAnimation | undefined,
  short: boolean,
  geometry?: AnimationGeometry,
  fade?: FadeOverrides,
): string {
  if (!anim || anim === "none") return "";
  const inCs = fade?.fadeInMs != null ? Math.max(0, Math.round(fade.fadeInMs / 10)) : (short ? 6 : 18);
  if (anim === "fade") return `\\fad(${inCs},0)`;
  if (anim === "pop")
    return short
      ? "\\fscx0\\fscy0\\t(0,80,\\fscx120\\fscy120)\\t(80,160,\\fscx100\\fscy100)"
      : "\\fscx0\\fscy0\\t(0,120,\\fscx130\\fscy130)\\t(120,220,\\fscx95\\fscy95)\\t(220,320,\\fscx100\\fscy100)";
  if (anim === "bounce")
    return short
      ? "\\t(0,80,\\fscx112\\fscy112)\\t(80,160,\\fscx100\\fscy100)"
      : "\\t(0,100,\\fscx112\\fscy112)\\t(100,210,\\fscx97\\fscy97)\\t(210,300,\\fscx100\\fscy100)";
  if (anim === "scale_in") return short ? "\\fscx80\\fscy80\\t(0,100,\\fscx100\\fscy100)" : "\\fscx80\\fscy80\\t(0,240,\\fscx100\\fscy100)";
  if (anim === "slide_up" && geometry) {
    const cx = Math.round(geometry.width / 2);
    const cy = geometry.alignment === 5 ? Math.round(geometry.height / 2) : geometry.height - geometry.marginBottom;
    const fromY = Math.min(geometry.height - 20, cy + 70);
    return `\\pos(${cx},${fromY})\\t(0,220,\\pos(${cx},${cy}))`;
  }
  return "";
}

/** Content only for exit animation (applied at end of line). durationCs = line duration in centiseconds. */
function animationExitContent(
  anim: CaptionAnimation | undefined,
  durationCs: number,
  short: boolean,
  fade?: FadeOverrides,
): string {
  if (!anim || anim === "none") return "";
  const outCs = fade?.fadeOutMs != null ? Math.max(0, Math.round(fade.fadeOutMs / 10)) : (short ? 4 : 10);
  const start = Math.max(0, durationCs - outCs);
  if (anim === "fade") return `\\t(${start},${durationCs},\\fad(0,${outCs}))`;
  if (anim === "pop" || anim === "bounce") {
    const exitLen = short ? 16 : 32;
    const s = Math.max(0, durationCs - exitLen);
    return `\\t(${s},${durationCs},\\fscx80\\fscy80)`;
  }
  return "";
}

/**
 * Combined enter + exit animation tag for a line with the given duration.
 * When enter === exit, returns the same as animationTag(enter, ...).
 */
export function combinedAnimationTag(
  enter: CaptionAnimation | undefined,
  exit: CaptionAnimation | undefined,
  durationSec: number,
  short = false,
  geometry?: AnimationGeometry,
  fade?: FadeOverrides,
): string {
  if ((!enter || enter === "none") && (!exit || exit === "none")) return "";
  const durationCs = Math.round(durationSec * 100);
  if (enter === exit && (enter === "fade" || enter === "pop" || enter === "bounce" || enter === "scale_in" || enter === "slide_up")) {
    return animationTag(enter, short, geometry, fade);
  }
  const e = animationEnterContent(enter, short, geometry, fade);
  const x = animationExitContent(exit, durationCs, short, fade);
  if (!e && !x) return "";
  return `{${e}${x}}`;
}

// ── ASS Karaoke ────────────────────────────────────────────────────────────

function toAssTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const cs = Math.round((secs % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** #RRGGBB → ASS &H00BBGGRR& (ASS uses reversed BGR order) */
function hexToAss(hex: string): string {
  const h = hex.replace("#", "").padEnd(6, "0");
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`;
}

/** Escape text hook for ASS Dialogue (backslash so \ doesn't break override parsing). */
function escapeAssText(s: string): string {
  return s.replace(/\\/g, "\\\\");
}

/** Author (text hook) style with font size scaled so long text stays on-screen when wrapped. */
function authorStyleForTextHook(height: number, text: string, fontName: string): string {
  const baseFont = Math.round(height / 14);
  const len = text.length;
  const scale = len <= 50 ? 1 : 50 / Math.min(len, 150);
  const fontSize = Math.max(Math.round(height / 28), Math.round(baseFont * scale));
  const marginV = Math.round(height * 0.10);
  return `Style: Author,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,8,50,50,${marginV},1`;
}

/** Group word-level segments into lines for karaoke/subtitle display. */
function groupWordsIntoLines(
  words: Segment[],
  maxWords: number,
  maxGap: number,
): Segment[][] {
  const lines: Segment[][] = [];
  let cur: Segment[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const gap = i > 0 ? w.start - words[i - 1].end : 0;
    if (cur.length && (cur.length >= maxWords || gap > maxGap)) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/** Group words into fixed-size chunks (1, 2, or 3 words per chunk). */
function groupWordsIntoChunks(words: Segment[], chunkSize: number): Segment[][] {
  const chunks: Segment[][] = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Chain mode: one event per word; each event shows the last `chunkSize` words (build-up then sliding).
 * E.g. 1_word: [Hey], [Hey brother], [Hey brother There's], …
 * E.g. 2_words: [Hey], [Hey brother], [brother There's], [There's an], …
 * E.g. 3_words: [Hey], [Hey brother], [Hey brother There's], [brother There's an], [There's an endless], …
 */
function groupWordsIntoCumulativeChunks(
  words: Segment[],
  chunkSize: number,
): { start: number; end: number; segments: Segment[] }[] {
  if (words.length === 0) return [];
  const out: { start: number; end: number; segments: Segment[] }[] = [];
  for (let i = 0; i < words.length; i++) {
    const from = Math.max(0, i - chunkSize + 1);
    const slice = words.slice(from, i + 1);
    if (slice.length === 0) continue;
    out.push({
      start: slice[0]!.start,
      end: slice[slice.length - 1]!.end,
      segments: slice,
    });
  }
  return out;
}

/** Parse displayMode into words-per-chunk (1–3) or lines-per-event (1–3). */
function parseDisplayMode(
  displayMode: CaptionDisplayMode,
): { type: "words"; count: number } | { type: "lines"; count: number } {
  switch (displayMode) {
    case "1_word":
      return { type: "words", count: 1 };
    case "2_words":
      return { type: "words", count: 2 };
    case "3_words":
      return { type: "words", count: 3 };
    case "1_line":
      return { type: "lines", count: 1 };
    case "2_lines":
      return { type: "lines", count: 2 };
    case "3_lines":
      return { type: "lines", count: 3 };
    default:
      return { type: "lines", count: 1 };
  }
}

/** How much text per block: 1/2/3 words or 1/2/3 lines. */
export type CaptionDisplayMode =
  | "1_word"
  | "2_words"
  | "3_words"
  | "1_line"
  | "2_lines"
  | "3_lines";
/** Vertical position: center (środek) or bottom (na dole). */
export type CaptionPosition = "center" | "bottom";

export interface AssKaraokeOptions {
  width: number;
  height: number;
  color: string;       // inactive word hex (#RRGGBB)
  activeColor: string; // karaoke fill hex (#RRGGBB)
  fontSize?: number;   // defaults to height / 21
  marginBottom: number;
  bold: boolean;
  outline: number;
  shadow?: number;     // ASS Shadow depth (0–6), default 2
  spacing?: number;   // ASS Spacing between chars (e.g. -1 to 8), default 2
  wordsPerLine?: number;
  displayMode?: CaptionDisplayMode;
  position?: CaptionPosition;
  boxBackground?: boolean;
  fontFamily?: string;
  captionAnimation?: CaptionAnimation;
  /** Separate enter animation (when set, used with captionAnimationExit for per-line combined tag). */
  captionAnimationEnter?: CaptionAnimation;
  /** Separate exit animation (when set, used with captionAnimationEnter for per-line combined tag). */
  captionAnimationExit?: CaptionAnimation;
  /** When set with durationSeconds, adds a top-center text hook line for the full video. */
  textHook?: string;
  durationSeconds?: number;
  /** Clamp all dialogue end times to this so the last word is not cut off when video length is shorter than transcript. */
  maxDurationSeconds?: number;
  /** When true and displayMode is 1/2/3 words, show cumulative text (Hey → Hey brother → Hey brother There's…). */
  concatWords?: boolean;
  /** When true, use primary colour for outline so text has a luminous glow (white halo). */
  glow?: boolean;
  /** Custom fade-in duration in ms (enter). Used when captionAnimation is "fade". */
  fadeInMs?: number;
  /** Custom fade-out duration in ms (exit). Used when captionAnimation is "fade". */
  fadeOutMs?: number;
}

function logAssBuild(
  builder: "karaoke" | "simple" | "pill",
  opts: { width: number; height: number; displayMode?: string; concatWords?: boolean },
  wordCount: number,
  eventCount: number,
  sampleTexts: string[],
  styleLine?: string,
  rawDialogueLines?: string[],
): void {
  console.log(
    `[ass] ${builder} build: PlayRes ${opts.width}x${opts.height}, displayMode=${opts.displayMode ?? "—"}, concatWords=${opts.concatWords ?? false}, segments=${wordCount}, dialogueLines=${eventCount}`,
  );
  if (styleLine) {
    console.log(`[ass]   Default style: ${styleLine.slice(0, 120)}${styleLine.length > 120 ? "…" : ""}`);
  }
  sampleTexts.slice(0, 5).forEach((t, i) => {
    const preview = t.length > 60 ? t.slice(0, 57) + "…" : t;
    console.log(`[ass]   dialogue ${i + 1} (text): "${preview}"`);
  });
  if (rawDialogueLines && rawDialogueLines.length > 0) {
    rawDialogueLines.slice(0, 2).forEach((line, i) => {
      const preview = line.length > 140 ? line.slice(0, 137) + "…" : line;
      console.log(`[ass]   raw Dialogue ${i + 1} (${line.length} chars): ${preview}`);
    });
  }
}

/**
 * Build an ASS subtitle file with true karaoke word highlighting.
 * Uses \kf tags so each word fills left→right with activeColor as it's sung.
 * Falls back to grouped-SRT-style display if segments are not word-level.
 */
export function buildAssKaraoke(
  words: Segment[],
  opts: AssKaraokeOptions,
): string {
  const primary = hexToAss(opts.color);
  const fill    = hexToAss(opts.activeColor);
  const fontSize = opts.fontSize ?? Math.round(opts.height / 21);
  const displayMode = opts.displayMode ?? "1_line";
  const position = opts.position ?? "bottom";
  const fontName = opts.fontFamily ?? "Arial";

  // ASS: Alignment 2 = bottom center, 5 = middle center. MarginV = distance from bottom for Alignment 2.
  const alignment = position === "center" ? 5 : 2;
  const marginV   = position === "bottom" ? opts.marginBottom : 0;

  const borderStyle = opts.boxBackground ? 3 : 1;
  const outlineVal  = opts.boxBackground ? 10 : opts.outline;
  const shadowVal  = opts.boxBackground ? 5  : (opts.shadow ?? 2);
  const spacingVal = opts.spacing ?? 2;
  const backColour  = opts.boxBackground ? "&HA0000000&" : "&HB0000000&";
  const outlineColourAss = opts.glow ? primary : "&H00000000&";

  const geometry: AnimationGeometry | undefined =
    opts.captionAnimation === "slide_up"
      ? { width: opts.width, height: opts.height, marginBottom: opts.marginBottom, alignment }
      : undefined;

  const authorStyle =
    opts.textHook && opts.durationSeconds != null
      ? authorStyleForTextHook(opts.height, opts.textHook, fontName)
      : "";

  const marginH = 140;
  const header = [
    "[Script Info]",
    "Title: BeatForge Lyrics",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${fontSize},${primary},${fill},${outlineColourAss},${backColour},${opts.bold ? -1 : 0},0,0,0,100,100,${spacingVal},0,${borderStyle},${outlineVal},${shadowVal},${alignment},${marginH},${marginH},${marginV},1`,
    ...(authorStyle ? [authorStyle] : []),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const authorEvent =
    opts.textHook && opts.durationSeconds != null
      ? `Dialogue: 0,0:00:00.00,${toAssTime(opts.durationSeconds)},Author,,0,0,0,,${escapeAssText(opts.textHook)}`
      : "";

  const fadeOverrides: FadeOverrides | undefined =
    opts.fadeInMs != null || opts.fadeOutMs != null
      ? { fadeInMs: opts.fadeInMs, fadeOutMs: opts.fadeOutMs }
      : undefined;
  const useSeparateAnim =
    opts.captionAnimationEnter != null || opts.captionAnimationExit != null;
  const animEnter = (opts.captionAnimationEnter ?? opts.captionAnimation) as CaptionAnimation | undefined;
  const animExit = (opts.captionAnimationExit ?? opts.captionAnimation) as CaptionAnimation | undefined;
  const defaultTag = animationTag(opts.captionAnimation, false, geometry, fadeOverrides);
  const tagFor = (start: number, end: number) =>
    useSeparateAnim
      ? combinedAnimationTag(animEnter, animExit, end - start + 0.25, false, geometry, fadeOverrides)
      : defaultTag;
  const kf = (seg: Segment) =>
    `{\\kf${Math.max(1, Math.round((seg.end - seg.start) * 100))}}${seg.text}`;

  if (!words.length) {
    const events = authorEvent ? `${authorEvent}\n` : "";
    return `${header}\n${events}`;
  }

  const maxEnd = opts.maxDurationSeconds;
  const clampEnd = (end: number) => (maxEnd != null ? Math.min(end, maxEnd) : end);

  const parsed = parseDisplayMode(displayMode);
  const events: string[] = [];
  const concat = opts.concatWords !== false;

  if (parsed.type === "words") {
    const chunkSize = parsed.count;
    const chunks = concat
      ? groupWordsIntoCumulativeChunks(words, chunkSize).map((c) => c.segments)
      : groupWordsIntoChunks(words, chunkSize);
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const start = chunk[0]!.start;
      const end = clampEnd(chunk[chunk.length - 1]!.end + 0.25);
      if (start >= end) continue;
      const text = chunk.map(kf).join(" ");
      events.push(`Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${tagFor(start, end)}${text}`);
    }
  } else {
    const wordsPerLine = opts.wordsPerLine ?? 4;
    const lines = groupWordsIntoLines(words, wordsPerLine, 0.5);
    const n = parsed.count;
    for (let i = 0; i < lines.length; i += n) {
      const group = lines.slice(i, i + n);
      const first = group[0]!;
      const last = group[group.length - 1]!;
      const start = first[0].start;
      const end = clampEnd(last[last.length - 1].end + 0.25);
      if (start >= end) continue;
      const text = group.map((line) => line.map(kf).join(" ")).join("\\N");
      events.push(`Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${tagFor(start, end)}${text}`);
    }
  }

  const eventBlock = [
    ...(authorEvent ? [authorEvent] : []),
    ...events,
  ].join("\n");
  const lyricEventCount = events.length;
  const sampleTexts = events
    .slice(0, 8)
    .map((e) => {
      const afterEffect = e.split(",,").pop() ?? "";
      return afterEffect.replace(/\{[^}]*\}/g, "").trim();
    })
    .filter(Boolean);
  const defaultStyleLine = `Style: Default,${fontName},${fontSize},${primary},${fill},${outlineColourAss},${backColour},${opts.bold ? -1 : 0},0,0,0,100,100,${spacingVal},0,${borderStyle},${outlineVal},${shadowVal},${alignment},${marginH},${marginH},${marginV},1`;
  logAssBuild(
    "karaoke",
    { width: opts.width, height: opts.height, displayMode: opts.displayMode, concatWords: opts.concatWords },
    words.length,
    lyricEventCount,
    sampleTexts,
    defaultStyleLine,
    events.slice(0, 2),
  );
  return `${header}\n${eventBlock}\n`;
}

// ── ASS Karaoke Pill ────────────────────────────────────────────────────────

/**
 * Build an ASS file with TikTok/CapCut-style karaoke pill highlights.
 *
 * Each word is shown individually (word-by-word mode) using two stacked
 * Dialogue layers at the same timestamp:
 *
 *   Layer 0  Pill_BG  — the pill shape.
 *            PrimaryColour = OutlineColour = pill/activeColor.
 *            A very large Outline (≈ 35% of font size) causes each character's
 *            rounded border to merge with its neighbours → continuous capsule.
 *            Text is the same colour as the outline, making it invisible;
 *            only the pill itself is visible.
 *            Spacing=0 packs characters together so outlines blend seamlessly.
 *
 *   Layer 1  Pill_Text — white text drawn on top of the pill.
 *            Thin black outline + subtle shadow for readability.
 *
 * Falls back gracefully when segments are not word-level (segment-by-segment).
 */
export function buildAssKaraokePill(
  words: Segment[],
  opts: AssKaraokeOptions,
): string {
  if (!words.length) return "";

  const fontSize  = opts.fontSize ?? Math.round(opts.height / 21);
  const pillR     = Math.max(6, Math.round(fontSize * 0.35));
  const pillColor = hexToAss(opts.activeColor);
  const white     = "&H00FFFFFF&";
  const black     = "&H80000000&";
  const fontName  = opts.fontFamily ?? "Arial";
  const position  = opts.position ?? "bottom";
  const alignment = position === "center" ? 5 : 2;
  const marginV   = position === "bottom" ? opts.marginBottom : 0;

  const authorStyle =
    opts.textHook && opts.durationSeconds != null
      ? authorStyleForTextHook(opts.height, opts.textHook, fontName)
      : "";
  const authorEvent =
    opts.textHook && opts.durationSeconds != null
      ? `Dialogue: 0,0:00:00.00,${toAssTime(opts.durationSeconds)},Author,,0,0,0,,${escapeAssText(opts.textHook)}`
      : "";

  const header = [
    "[Script Info]",
    "Title: BeatForge Lyrics",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Pill_BG,${fontName},${fontSize},${pillColor},${pillColor},${pillColor},&H00000000,-1,0,0,0,100,100,0,0,1,${pillR},0,${alignment},140,140,${marginV},1`,
    `Style: Pill_Text,${fontName},${fontSize},${white},${white},${black},&H00000000,-1,0,0,0,100,100,2,0,1,3,1,${alignment},140,140,${marginV},1`,
    ...(authorStyle ? [authorStyle] : []),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  // Word-level items — fall back to per-segment if not word-level
  const items: Segment[] = words[0]?.word
    ? words
    : words.flatMap((seg) => {
        const ws = seg.text.trim().split(/\s+/).filter(Boolean);
        if (!ws.length) return [];
        const dur = (seg.end - seg.start) / ws.length;
        return ws.map((w, i) => ({
          start: +(seg.start + i * dur).toFixed(2),
          end:   +(seg.start + (i + 1) * dur).toFixed(2),
          text:  w,
          word:  true,
        }));
      });

  const pillFade: FadeOverrides | undefined =
    opts.fadeInMs != null || opts.fadeOutMs != null
      ? { fadeInMs: opts.fadeInMs, fadeOutMs: opts.fadeOutMs }
      : undefined;
  const aTag = animationTag(opts.captionAnimation, true, undefined, pillFade); // short=true: snappy per-word timing

  const maxEnd = opts.maxDurationSeconds;
  const pillEvents = items
    .flatMap((w) => {
      const endSec = maxEnd != null ? Math.min(w.end + 0.05, maxEnd) : w.end + 0.05;
      if (w.start >= endSec) return [];
      const s = toAssTime(w.start);
      const e = toAssTime(endSec);
      return [
        `Dialogue: 0,${s},${e},Pill_BG,,0,0,0,,${aTag}  ${w.text}  `,
        `Dialogue: 1,${s},${e},Pill_Text,,0,0,0,,${aTag}${w.text}`,
      ];
    })
    .join("\n");

  const eventBlock = [...(authorEvent ? [authorEvent] : []), pillEvents].filter(Boolean).join("\n");
  const dialogueCount = items.length * 2;
  const sampleTexts = items.slice(0, 5).map((w) => w.text);
  logAssBuild(
    "pill",
    { width: opts.width, height: opts.height, displayMode: "1_word", concatWords: false },
    words.length,
    dialogueCount,
    sampleTexts,
  );
  return `${header}\n${eventBlock}\n`;
}

// ── ASS Simple (bold_center / minimal_clean) ────────────────────────────────
// Groups word-level segments into 4-word lines, displays them all at once.
// Uses the `ass=` filter — avoids FFmpeg 8.x subtitles+force_style parsing bugs.

export type CaptionStyle = "bold_center" | "karaoke" | "karaoke_pill" | "minimal_clean";

export interface AssSimpleOptions {
  width: number;
  height: number;
  color: string; // hex #RRGGBB
  style: CaptionStyle;
  marginBottom: number;
  wordsPerLine?: number;
  displayMode?: CaptionDisplayMode;
  position?: CaptionPosition;
  boxBackground?: boolean;
  fontFamily?: string;
  captionAnimation?: CaptionAnimation;
  /** Override outline width (ASS Outline, 0–12). */
  outline?: number;
  /** Override shadow depth (ASS Shadow, 0–6). */
  shadow?: number;
  /** Override letter spacing (ASS Spacing). */
  spacing?: number;
  /** Override font size in px (overrides style default). */
  fontSize?: number;
  /** When set with durationSeconds, adds a top-center text hook line for the full video. */
  textHook?: string;
  durationSeconds?: number;
  /** Clamp all dialogue end times to this so the last word is not cut off when video length is shorter than transcript. */
  maxDurationSeconds?: number;
  /** When true and displayMode is 1/2/3 words, show cumulative text (Hey → Hey brother → …). */
  concatWords?: boolean;
  /** When true, use primary colour for outline so text has a luminous glow (white halo). */
  glow?: boolean;
  /** Custom fade-in (enter) and fade-out (exit) in ms when animation is "fade". */
  fadeInMs?: number;
  fadeOutMs?: number;
  captionAnimationEnter?: CaptionAnimation;
  captionAnimationExit?: CaptionAnimation;
}

export function buildAssSimple(
  words: Segment[],
  opts: AssSimpleOptions,
): string {
  const primary  = hexToAss(opts.color);
  const fontName = opts.fontFamily ?? "Arial";
  // Outline colour: same as text for luminous glow, else black
  const outlineColourAss = opts.glow ? primary : "&H00000000&";
  const shadow = "&H80000000&";

  // Style-specific tweaks (overridable by opts.outline / shadow / spacing / fontSize)
  const isBold   = opts.style !== "minimal_clean";
  const defaultFontSize =
    opts.style === "minimal_clean"
      ? Math.round(opts.height / 28)
      : Math.round(opts.height / 21);
  const fontSize = opts.fontSize ?? defaultFontSize;

  const borderStyle = opts.boxBackground ? 3 : 1;
  const outlineW   = opts.outline ?? (opts.boxBackground ? 10 : (opts.style === "minimal_clean" ? 1 : 4));
  const shadowW    = opts.shadow ?? (opts.boxBackground ? 5  : (opts.style === "minimal_clean" ? 1 : 2));
  const spacingVal = opts.spacing ?? 2;

  const displayMode = opts.displayMode ?? "1_line";
  const position = opts.position ?? "bottom";
  const alignment = position === "center" ? 5 : 2;
  const marginV   = position === "bottom" ? opts.marginBottom : 0;

  const geometry: AnimationGeometry | undefined =
    opts.captionAnimation === "slide_up"
      ? { width: opts.width, height: opts.height, marginBottom: opts.marginBottom, alignment }
      : undefined;

  const authorStyle =
    opts.textHook && opts.durationSeconds != null
      ? authorStyleForTextHook(opts.height, opts.textHook, fontName)
      : "";
  const authorEvent =
    opts.textHook && opts.durationSeconds != null
      ? `Dialogue: 0,0:00:00.00,${toAssTime(opts.durationSeconds)},Author,,0,0,0,,${escapeAssText(opts.textHook)}`
      : "";

  if (!words.length) {
    if (!authorEvent) return "";
    return `${[
      "[Script Info]",
      "Title: BeatForge Lyrics",
      "ScriptType: v4.00+",
      "WrapStyle: 2",
      "ScaledBorderAndShadow: yes",
      `PlayResX: ${opts.width}`,
      `PlayResY: ${opts.height}`,
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: Default,${fontName},${fontSize},${primary},${primary},${outlineColourAss},${opts.boxBackground ? "&HA0000000&" : shadow},${isBold ? -1 : 0},0,0,0,100,100,${spacingVal},0,${borderStyle},${outlineW},${shadowW},${alignment},140,140,${marginV},1`,
      ...(authorStyle ? [authorStyle] : []),
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ].join("\n")}\n${authorEvent}\n`;
  }

  let dialogueLines: { start: number; end: number; text: string }[];

  if (words[0].word) {
    const parsed = parseDisplayMode(displayMode);
    const concat = opts.concatWords !== false;
    if (parsed.type === "words") {
      const chunkSize = parsed.count;
      if (concat) {
        const cumulative = groupWordsIntoCumulativeChunks(words, chunkSize);
        dialogueLines = cumulative.map((c) => ({
          start: c.start,
          end: c.end + 0.2,
          text: c.segments.map((w) => w.text).join(" "),
        }));
      } else {
        const chunks = groupWordsIntoChunks(words, chunkSize);
        dialogueLines = chunks.map((chunk) => ({
          start: chunk[0]!.start,
          end: chunk[chunk.length - 1]!.end + 0.2,
          text: chunk.map((w) => w.text).join(" "),
        }));
      }
    } else {
      const wordsPerLine = opts.wordsPerLine ?? 4;
      const lines = groupWordsIntoLines(words, wordsPerLine, 0.5);
      const n = parsed.count;
      dialogueLines = [];
      for (let i = 0; i < lines.length; i += n) {
        const group = lines.slice(i, i + n);
        const first = group[0]!;
        const last = group[group.length - 1]!;
        dialogueLines.push({
          start: first[0].start,
          end: last[last.length - 1].end + 0.2,
          text: group.map((line) => line.map((w) => w.text).join(" ")).join("\\N"),
        });
      }
    }
  } else {
    dialogueLines = words.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
    }));
    console.log(`[ass] simple: non-word-level path, ${dialogueLines.length} lines from ${words.length} segments`);
    dialogueLines.slice(0, 3).forEach((l, i) => {
      console.log(`[ass]   line ${i + 1} text (${l.text.length} chars): "${l.text.slice(0, 60)}${l.text.length > 60 ? "…" : ""}"`);
    });
  }

  const header = [
    "[Script Info]",
    "Title: BeatForge Lyrics",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    "",
    "[V4+ Styles]",
"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: Default,${fontName},${fontSize},${primary},${primary},${outlineColourAss},${opts.boxBackground ? "&HA0000000&" : shadow},${isBold ? -1 : 0},0,0,0,100,100,${spacingVal},0,${borderStyle},${outlineW},${shadowW},${alignment},140,140,${marginV},1`,
      ...(authorStyle ? [authorStyle] : []),
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const fadeOverrides: FadeOverrides | undefined =
    opts.fadeInMs != null || opts.fadeOutMs != null
      ? { fadeInMs: opts.fadeInMs, fadeOutMs: opts.fadeOutMs }
      : undefined;
  const useSeparateAnim =
    opts.captionAnimationEnter != null || opts.captionAnimationExit != null;
  const animEnter = (opts.captionAnimationEnter ?? opts.captionAnimation) as CaptionAnimation | undefined;
  const animExit = (opts.captionAnimationExit ?? opts.captionAnimation) as CaptionAnimation | undefined;
  const defaultTag = animationTag(opts.captionAnimation, false, geometry, fadeOverrides);
  const tagFor = (start: number, end: number) =>
    useSeparateAnim
      ? combinedAnimationTag(animEnter, animExit, end - start, false, geometry, fadeOverrides)
      : defaultTag;
  const maxEnd = opts.maxDurationSeconds;
  const lyricEvents = dialogueLines
    .map((l) => {
      const end = maxEnd != null ? Math.min(l.end, maxEnd) : l.end;
      if (l.start >= end) return null;
      return `Dialogue: 0,${toAssTime(l.start)},${toAssTime(end)},Default,,0,0,0,,${tagFor(l.start, end)}${l.text}`;
    })
    .filter((line): line is string => line != null)
    .join("\n");

  const eventBlock = [...(authorEvent ? [authorEvent] : []), lyricEvents].filter(Boolean).join("\n");
  const sampleTexts = dialogueLines.slice(0, 8).map((l) => (l.text.length > 60 ? l.text.slice(0, 57) + "…" : l.text));
  const defaultStyleLine = `Style: Default,${fontName},${fontSize},${primary},${primary},${outlineColourAss},${opts.boxBackground ? "&HA0000000&" : shadow},${isBold ? -1 : 0},0,0,0,100,100,${spacingVal},0,${borderStyle},${outlineW},${shadowW},${alignment},140,140,${marginV},1`;
  const rawDialogueLines = dialogueLines
    .slice(0, 2)
    .map((l) => {
      const end = maxEnd != null ? Math.min(l.end, maxEnd) : l.end;
      if (l.start >= end) return null;
      return `Dialogue: 0,${toAssTime(l.start)},${toAssTime(end)},Default,,0,0,0,,${tagFor(l.start, end)}${l.text}`;
    })
    .filter((line): line is string => line != null);
  logAssBuild(
    "simple",
    { width: opts.width, height: opts.height, displayMode: opts.displayMode, concatWords: opts.concatWords },
    words.length,
    dialogueLines.length,
    sampleTexts,
    defaultStyleLine,
    rawDialogueLines,
  );
  return `${header}\n${eventBlock}\n`;
}

// ── Legacy: kept for backward compat but no longer called ──────────────────
export function captionStyleToAss(
  style: CaptionStyle,
  marginBottom: number,
  marginSide: number,
  color = "#FFFFFF",
): string {
  const hexColor = color.replace("#", "&H00") + "&";
  const base = `MarginL=${marginSide},MarginR=${marginSide},MarginV=${marginBottom},PrimaryColour=${hexColor}`;
  switch (style) {
    case "bold_center":
      return `${base},Fontsize=22,Bold=1,Alignment=2`;
    case "karaoke":
      return `${base},Fontsize=20,Bold=1,Alignment=2,OutlineColour=&H00FF6600&,Outline=2`;
    case "minimal_clean":
      return `${base},Fontsize=16,Bold=0,Alignment=2`;
    default:
      return `${base},Fontsize=22,Bold=1,Alignment=2`;
  }
}
