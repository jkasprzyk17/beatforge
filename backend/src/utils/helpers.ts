import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..'); // /BeatForge root

export const DIRS = {
  music:   path.join(ROOT, 'music'),
  clips:   path.join(ROOT, 'clips'),
  exports: path.join(ROOT, 'exports'),
  thumbs:  path.join(ROOT, 'exports', 'thumbs'),
  tmp:     path.join(ROOT, 'exports', 'tmp'),
};

export function ensureDirs(): void {
  for (const dir of Object.values(DIRS)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const newId  = () => randomUUID().replace(/-/g, '').slice(0, 12);

// ── Path helpers ──────────────────────────────────────────

export function musicDir(musicId: string): string {
  return path.join(DIRS.music, musicId);
}

export function musicFile(musicId: string): string {
  const dir = musicDir(musicId);
  if (!fs.existsSync(dir)) throw new Error(`music_id not found: ${musicId}`);
  const files = fs.readdirSync(dir).filter(f => /\.(mp3|wav|aac|flac|m4a)$/i.test(f));
  if (!files.length) throw new Error(`No audio file in ${dir}`);
  return path.join(dir, files[0]);
}

export function clipsDir(clipsId: string): string {
  return path.join(DIRS.clips, clipsId);
}

export function clipFiles(clipsId: string): string[] {
  const dir = clipsDir(clipsId);
  if (!fs.existsSync(dir)) throw new Error(`clips_id not found: ${clipsId}`);
  return fs
    .readdirSync(dir)
    .filter(f => /\.(mp4|mov|avi|mkv|webm)$/i.test(f))
    .map(f => path.join(dir, f));
}

export function exportVideoPath(jobId: string, variant: number, platform: string): string {
  return path.join(DIRS.exports, `${jobId}_v${variant}_${platform}.mp4`);
}

export function exportSrtPath(jobId: string, variant: number): string {
  return path.join(DIRS.exports, `${jobId}_v${variant}.srt`);
}

export function exportAssPath(jobId: string, variant: number): string {
  return path.join(DIRS.exports, `${jobId}_v${variant}.ass`);
}

export function previewPath(jobId: string): string {
  return path.join(DIRS.exports, `preview_${jobId}.mp4`);
}

export function thumbPath(jobId: string, variant: number): string {
  return path.join(DIRS.thumbs, `${jobId}_v${variant}.jpg`);
}

export function collectionThumbPath(collectionId: string): string {
  return path.join(DIRS.thumbs, `col_${collectionId}.jpg`);
}

export function presetThumbPath(presetId: string): string {
  return path.join(DIRS.thumbs, `preset_${presetId}.jpg`);
}

export function tmpSegmentPath(jobId: string, idx: number): string {
  return path.join(DIRS.tmp, `${jobId}_seg${idx}.mp4`);
}

export function tmpConcatPath(jobId: string): string {
  return path.join(DIRS.tmp, `${jobId}_concat.mp4`);
}

export function urlFor(absPath: string): string {
  const rel = path.relative(DIRS.exports, absPath);
  return `/exports/${rel.replace(/\\/g, '/')}`;
}
