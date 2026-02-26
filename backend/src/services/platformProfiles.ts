/**
 * Platform-specific encoding profiles for TikTok, Instagram Reels/Stories, YouTube Shorts.
 */

export type PlatformId = 'tiktok' | 'reels' | 'stories' | 'shorts';

export interface PlatformProfile {
  id:                    PlatformId;
  label:                 string;
  emoji:                 string;
  width:                 number;
  height:                number;
  maxDuration:           number;
  defaultDuration:       number;
  fps:                   number;
  videoBitrate:          string;
  audioBitrate:          string;
  captionMarginBottom:   number;
  captionMarginSide:     number;
  captionStyle:          string;
  extraFlags:            string[];
}

export const PROFILES: Record<PlatformId, PlatformProfile> = {
  tiktok: {
    id: 'tiktok', label: 'TikTok', emoji: '🎵',
    width: 1080, height: 1920,
    maxDuration: 60, defaultDuration: 20, fps: 30,
    videoBitrate: '8M', audioBitrate: '192k',
    captionMarginBottom: 160, captionMarginSide: 20,
    captionStyle: 'bold_center',
    extraFlags: ['-movflags', '+faststart'],
  },
  reels: {
    id: 'reels', label: 'Instagram Reels', emoji: '📸',
    width: 1080, height: 1920,
    maxDuration: 90, defaultDuration: 20, fps: 30,
    videoBitrate: '8M', audioBitrate: '192k',
    captionMarginBottom: 200, captionMarginSide: 20,
    captionStyle: 'bold_center',
    extraFlags: ['-movflags', '+faststart'],
  },
  stories: {
    id: 'stories', label: 'Instagram Stories', emoji: '💬',
    width: 1080, height: 1920,
    maxDuration: 15, defaultDuration: 15, fps: 30,
    videoBitrate: '6M', audioBitrate: '128k',
    captionMarginBottom: 300, captionMarginSide: 40,
    captionStyle: 'minimal_clean',
    extraFlags: ['-movflags', '+faststart'],
  },
  shorts: {
    id: 'shorts', label: 'YouTube Shorts', emoji: '▶️',
    width: 1080, height: 1920,
    maxDuration: 60, defaultDuration: 20, fps: 60,
    videoBitrate: '10M', audioBitrate: '192k',
    captionMarginBottom: 120, captionMarginSide: 20,
    captionStyle: 'bold_center',
    extraFlags: [],
  },
};

export const ALL_PLATFORM_IDS = Object.keys(PROFILES) as PlatformId[];

export function getProfile(id: PlatformId): PlatformProfile {
  return PROFILES[id];
}

// ── Encoder config ────────────────────────────────────────
//
// Supported VIDEO_ENCODER values:
//   libx264    — CPU (default, always works)
//   h264_nvenc — NVIDIA GPU (RTX / GTX 10xx+)
//   h264_amf   — AMD GPU (RX 5000+, Windows)
//   h264_qsv   — Intel Quick Sync (6th gen iGPU+)
//   auto       — wykrywa automatycznie najlepszy enkoder (patrz server.ts)

export interface EncoderConfig {
  codec:        string;
  presetFlags:  string[];              // np. ["-preset", "fast"]
  qualityFlags: (q: number) => string[]; // np. (q) => ["-crf", String(q)]
}

export function getEncoder(): EncoderConfig {
  const enc = (process.env.VIDEO_ENCODER ?? 'libx264').toLowerCase();

  switch (enc) {
    case 'h264_nvenc':
    case 'hevc_nvenc':
      return {
        codec:        enc,
        presetFlags:  ['-preset', 'p4'],
        // -cq: constant quality (0=best, 51=worst; ~28 ≈ libx264 CRF 23)
        qualityFlags: (q) => ['-cq', String(q)],
      };

    case 'h264_amf':
      // AMD AMF: constant QP mode.
      // qp_i (I-frames) slightly lower than qp_p (P-frames) for better quality.
      return {
        codec:        enc,
        presetFlags:  ['-quality', 'balanced', '-usage', 'transcoding'],
        qualityFlags: (q) => ['-rc', 'cqp', '-qp_i', String(Math.max(0, q - 4)), '-qp_p', String(Math.max(0, q - 2))],
      };

    case 'h264_qsv':
      return {
        codec:        enc,
        presetFlags:  ['-preset', 'fast'],
        qualityFlags: (q) => ['-global_quality', String(q)],
      };

    default: // libx264 or unknown — safe fallback
      return {
        codec:        enc,
        presetFlags:  ['-preset', 'fast'],
        qualityFlags: (q) => ['-crf', String(q)],
      };
  }
}
