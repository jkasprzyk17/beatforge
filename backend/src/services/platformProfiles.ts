/**
 * Platform-specific encoding profiles for TikTok, Instagram Reels/Stories, YouTube Shorts.
 */

export type PlatformId = 'tiktok' | 'reels' | 'stories' | 'shorts';

const encoder = () => process.env.VIDEO_ENCODER ?? 'libx264';
const preset  = () => encoder() === 'h264_nvenc' ? 'p4' : 'fast';
const qFlag   = () => encoder() === 'h264_nvenc' ? '-cq' : '-crf';

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

export function getEncoder() {
  return { codec: encoder(), preset: preset(), qFlag: qFlag() };
}
