/**
 * Karaoke-style ASS subtitle generator.
 *
 * Consumes word-level timestamps (e.g. from Whisper), groups words into lines
 * (max 5 words or 2.5 s per line), and writes an ASS file with \k tags
 * compatible with ffmpeg: ffmpeg -i video.mp4 -vf "ass=subs.ass" output.mp4
 *
 * Style: centered text, Fontsize 80, Alignment 5, Outline 6, Shadow 0.
 */

import { writeFile } from "node:fs/promises";

// ── Types ───────────────────────────────────────────────────────────────

/** Word-level timestamp; compatible with Whisper-style { word, start, end }. */
export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

// ── Constants (ASS style as specified) ───────────────────────────────────

const PLAY_RES_X = 1920;
const PLAY_RES_Y = 1080;
const POS_CENTER = "960,540"; // center for 1920×1080
const FONT_SIZE = 80;
const ALIGNMENT = 5; // center
const OUTLINE = 6;
const SHADOW = 0;

/** Max words per line. */
const MAX_WORDS_PER_LINE = 5;
/** Max line duration in seconds. */
const MAX_LINE_DURATION_S = 2.5;

// ── Helpers ─────────────────────────────────────────────────────────────

/** Format seconds as ASS time: H:MM:SS.cc (centiseconds). */
function toAssTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const cs = Math.round((secs % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Word duration in centiseconds for \k tag (min 1). */
function durationCentiseconds(start: number, end: number): number {
  return Math.max(1, Math.round((end - start) * 100));
}

/** Group words into lines: max 5 words per line OR max 2.5 s per line. */
function groupIntoLines(words: WordTimestamp[]): WordTimestamp[][] {
  const lines: WordTimestamp[][] = [];
  let cur: WordTimestamp[] = [];

  for (const w of words) {
    const firstStart = cur.length > 0 ? cur[0]!.start : w.start;
    const lineDuration = w.end - firstStart;

    if (
      cur.length >= MAX_WORDS_PER_LINE ||
      (cur.length > 0 && lineDuration > MAX_LINE_DURATION_S)
    ) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

/** Build karaoke text for one line: {\k120}Hello {\k70}from ... */
function buildKaraokeLine(words: WordTimestamp[]): string {
  return words
    .map((w) => `{\\k${durationCentiseconds(w.start, w.end)}}${w.word}`)
    .join(" ");
}

/** Build full ASS content (header + events). */
function buildAssContent(words: WordTimestamp[]): string {
  const header = [
    "[Script Info]",
    "Title: BeatForge Karaoke",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${FONT_SIZE},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${OUTLINE},${SHADOW},${ALIGNMENT},50,50,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  if (words.length === 0) return `${header}\n`;

  const lines = groupIntoLines(words);
  const events = lines
    .map((line) => {
      const start = line[0]!.start;
      const end = line[line.length - 1]!.end;
      const karaokeText = buildKaraokeLine(line);
      const text = `{\\pos(${POS_CENTER})}${karaokeText}`;
      return `Dialogue: 0,${toAssTime(start)},${toAssTime(end)},Default,,0,0,0,,${text}`;
    })
    .join("\n");

  return `${header}\n${events}\n`;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Generate a karaoke-style ASS subtitle file from word-level timestamps.
 *
 * - Converts word duration to centiseconds and emits \k tags.
 * - Groups words into lines: max 5 words per line OR max 2.5 s per line.
 * - Each line is a Dialogue with {\pos(960,540)} and karaoke text.
 * - Style: Fontsize 80, Alignment 5, Outline 6, Shadow 0.
 *
 * @param words - Array of { word, start, end } (e.g. from Whisper).
 * @param outputPath - File path to write the .ass file (e.g. subs.ass).
 */
export async function generateAssSubtitles(
  words: WordTimestamp[],
  outputPath: string,
): Promise<void> {
  const content = buildAssContent(words);
  await writeFile(outputPath, content, "utf8");
}
