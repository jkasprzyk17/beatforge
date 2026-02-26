/**
 * BPM detection using ffmpeg (extract raw PCM) + energy-based onset detection.
 * No Python/librosa needed — pure Node.js.
 */

import { spawn } from 'node:child_process';

export interface BeatResult {
  bpm:   number;
  beats: number[]; // timestamps in seconds
}

// ── Extract raw PCM via ffmpeg ────────────────────────────

function extractPCM(audioPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn('ffmpeg', [
      '-i',  audioPath,
      '-f',  'f32le',   // raw float32 little-endian
      '-ac', '1',       // mono
      '-ar', '22050',   // 22kHz — enough for beat detection
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) {
        reject(new Error(`ffmpeg PCM extraction failed (code ${code})`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    proc.on('error', reject);
  });
}

// ── Energy-based BPM detector ─────────────────────────────

function detectFromPCM(buf: Buffer): BeatResult {
  const FRAME   = 512;
  const SR      = 22050;
  const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

  // RMS energy per frame
  const energy: number[] = [];
  for (let i = 0; i + FRAME < samples.length; i += FRAME) {
    let rms = 0;
    for (let j = 0; j < FRAME; j++) rms += samples[i + j] ** 2;
    energy.push(Math.sqrt(rms / FRAME));
  }

  // Moving average for local threshold
  const W = 20; // window in frames
  const threshold: number[] = energy.map((_, i) => {
    const lo = Math.max(0, i - W);
    const hi = Math.min(energy.length, i + W);
    const slice = energy.slice(lo, hi);
    return (slice.reduce((a, b) => a + b, 0) / slice.length) * 1.4;
  });

  // Onset frames (local maxima above threshold, min 0.2s apart)
  const minGap = Math.ceil((0.2 * SR) / FRAME);
  const onsets: number[] = [];
  let lastOnset = -minGap;

  for (let i = 1; i < energy.length - 1; i++) {
    if (
      energy[i] > threshold[i] &&
      energy[i] > energy[i - 1] &&
      energy[i] >= energy[i + 1] &&
      i - lastOnset >= minGap
    ) {
      onsets.push((i * FRAME) / SR);
      lastOnset = i;
    }
  }

  if (onsets.length < 4) {
    // Not enough onsets → fallback BPM
    return { bpm: 120, beats: onsets };
  }

  // Inter-onset intervals → BPM via median
  const intervals = onsets
    .slice(1)
    .map((t, i) => t - onsets[i])
    .filter(d => d > 0.2 && d < 2.0); // filter outliers

  if (!intervals.length) return { bpm: 120, beats: onsets };

  const sorted  = [...intervals].sort((a, b) => a - b);
  const median  = sorted[Math.floor(sorted.length / 2)];
  const rawBpm  = 60 / median;

  // Snap to musical BPM grid (allow 2× / 0.5× octave errors)
  let bpm = rawBpm;
  if (bpm < 60)  bpm *= 2;
  if (bpm > 200) bpm /= 2;
  bpm = Math.round(bpm);

  return { bpm, beats: onsets };
}

// ── Public API ────────────────────────────────────────────

export async function analyseBeats(audioPath: string): Promise<BeatResult> {
  try {
    const pcm = await extractPCM(audioPath);
    return detectFromPCM(pcm);
  } catch (err) {
    console.warn('[beatDetection] fallback to 120 BPM:', err);
    return { bpm: 120, beats: [] };
  }
}
