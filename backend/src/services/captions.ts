/**
 * Local Whisper transcription via @xenova/transformers.
 * No Python, no API key — model downloads once to ~/.cache/huggingface.
 *
 * Also generates SRT subtitle files from segments.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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

  env.cacheDir = path.resolve("..", ".whisper-cache");
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

function segmentsToWords(segments: Segment[]): Segment[] {
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

export interface AssKaraokeOptions {
  width: number;
  height: number;
  color: string; // inactive word hex (#RRGGBB)
  activeColor: string; // karaoke fill hex (#RRGGBB)
  fontSize?: number; // defaults to height / 21
  marginBottom: number;
  bold: boolean;
  outline: number;
  wordsPerLine?: number;
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
  const fill = hexToAss(opts.activeColor);
  const fontSize = opts.fontSize ?? Math.round(opts.height / 21);
  const lines = groupWordsIntoLines(words, opts.wordsPerLine ?? 4, 0.5);

  const header = [
    "[Script Info]",
    "Title: BeatForge Lyrics",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${fontSize},${primary},${fill},&H00000000,&HB0000000,${opts.bold ? -1 : 0},0,0,0,100,100,2,0,1,${opts.outline},2,2,50,50,${opts.marginBottom},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = lines
    .map((line) => {
      const start = line[0].start;
      const end = line[line.length - 1].end + 0.25; // small hold after last word
      const text = line
        .map(
          (w) =>
            `{\\kf${Math.max(1, Math.round((w.end - w.start) * 100))}}${w.text}`,
        )
        .join(" ");
      return `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text}`;
    })
    .join("\n");

  return `${header}\n${events}\n`;
}

// ── ASS Simple (bold_center / minimal_clean) ────────────────────────────────
// Groups word-level segments into 4-word lines, displays them all at once.
// Uses the `ass=` filter — avoids FFmpeg 8.x subtitles+force_style parsing bugs.

export type CaptionStyle = "bold_center" | "karaoke" | "minimal_clean";

export interface AssSimpleOptions {
  width: number;
  height: number;
  color: string; // hex #RRGGBB
  style: CaptionStyle;
  marginBottom: number;
  wordsPerLine?: number;
}

export function buildAssSimple(
  words: Segment[],
  opts: AssSimpleOptions,
): string {
  const primary = hexToAss(opts.color);
  // Black shadow / outline colour
  const outline = "&H00000000&";
  const shadow = "&H80000000&";

  // Style-specific tweaks
  const isBold = opts.style !== "minimal_clean";
  const fontSize =
    opts.style === "minimal_clean"
      ? Math.round(opts.height / 28)
      : Math.round(opts.height / 21);
  const outlineW = opts.style === "minimal_clean" ? 1 : 4;
  const shadowW = opts.style === "minimal_clean" ? 1 : 2;

  // Use original segments if not word-level; otherwise group into lines
  let dialogueLines: { start: number; end: number; text: string }[];
  if (!words.length) return "";

  if (words[0].word) {
    dialogueLines = groupWordsIntoLines(words, opts.wordsPerLine ?? 4, 0.5).map(
      (line) => ({
        start: line[0].start,
        end: line[line.length - 1].end + 0.2,
        text: line.map((w) => w.text).join(" "),
      }),
    );
  } else {
    dialogueLines = words.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
    }));
  }

  const header = [
    "[Script Info]",
    "Title: BeatForge Lyrics",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${fontSize},${primary},${primary},${outline},${shadow},${isBold ? -1 : 0},0,0,0,100,100,2,0,1,${outlineW},${shadowW},2,50,50,${opts.marginBottom},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = dialogueLines
    .map(
      (l) =>
        `Dialogue: 0,${toAssTime(l.start)},${toAssTime(l.end)},Default,,0,0,0,,${l.text}`,
    )
    .join("\n");

  return `${header}\n${events}\n`;
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
