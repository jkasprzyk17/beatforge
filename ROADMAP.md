# BeatForge — Enhancement Roadmap

> Full architecture analysis, identified gaps, and prioritized feature backlog for making BeatForge generate more viral, TikTok/CapCut-grade short-form video edits.

---

## Table of Contents

1. [Current Architecture Summary](#1-current-architecture-summary)
2. [Identified Gaps & Limitations](#2-identified-gaps--limitations)
3. [Proposed Effects & Enhancements](#3-proposed-effects--enhancements)
4. [DB / Schema Changes](#4-db--schema-changes)
5. [API Changes](#5-api-changes)
6. [FFmpeg Pipeline Upgrades](#6-ffmpeg-pipeline-upgrades)
7. [Frontend Integration](#7-frontend-integration)
8. [Priority Roadmap](#8-priority-roadmap)

---

## 1. Current Architecture Summary

### Pipeline Flow

```
POST /api/generate-batch
  │
  ├─ analyseBeats()           beatDetection.ts   → PCM → RMS → BPM + beat[]
  ├─ transcribeAudio()        captions.ts        → Whisper ONNX → word segments
  ├─ buildAssKaraoke/Simple() captions.ts        → segments → .ass subtitle file
  └─ assembleVideo()          videoAssembler.ts
       │
       ├─ trimAndCrop() × N   filtergraph.ts     → crop → scale → fps → [zoompan] → [setpts] → [eq/curves]
       ├─ concat / xfade                         → fade | pixelize | dissolve | wipeleft
       ├─ muxAudio()                             → -map 0:v -map 1:a
       ├─ burnCaptions()                         → subtitles=file.ass
       └─ extractThumbnail()
```

### DB Tables (SQLite + WAL)

| Table              | Purpose                                 |
| ------------------ | --------------------------------------- |
| `tracks`           | Uploaded audio files, BPM, duration     |
| `transcriptions`   | Whisper output per music_id             |
| `collections`      | Named clip groups with folder/mood      |
| `collection_clips` | clip_path rows per collection           |
| `hooks`            | Text hooks with optional mood_id        |
| `presets`          | Named presets with `config_json` blob   |
| ❌ `jobs`          | **Missing** — stored in-memory only     |
| ❌ `exports`       | **Missing** — no generation history     |
| ❌ `clip_metadata` | **Missing** — no per-clip ffprobe cache |

### Preset Config Shape (current)

```json
{
  "captionStyle": "bold_center | karaoke | minimal_clean",
  "captionColor": "#RRGGBB",
  "clipCutStrategy": "beat | random",
  "transition": "none | fade | glitch | dissolve | wipeleft | pixelize",
  "zoomPunch": true,
  "speedVariation": true,
  "colorGrade": "dark_contrast | vibrant | muted | warm | cold | null",
  "energyBasedCuts": true,
  "maxDuration": 25
}
```

---

## 2. Identified Gaps & Limitations

### 2.1 FFmpeg Pipeline — Critical

| Gap                                                                     | Location                                | Impact                                         |
| ----------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `beats.beats[]` timestamps computed but **never used** for clip cuts    | `videoAssembler.ts:222`                 | Cuts are uniformly timed, not musically synced |
| `energyBasedCuts` flag stored in preset but **never read** in assembler | `presetService.ts`, `videoAssembler.ts` | Dead config — does nothing                     |
| `glitch` transition maps to `pixelize` — no real RGB glitch             | `filtergraph.ts:157`                    | Effect is weak, not trendy                     |
| `zoompan` runs over the whole clip, not at beat entry                   | `filtergraph.ts:83`                     | Punch feels sluggish                           |
| No motion blur on `setpts` speed-up                                     | `filtergraph.ts:91`                     | Sped-up footage looks choppy                   |
| No chromatic aberration / RGB split                                     | —                                       | Missing viral aesthetic                        |
| No flash frame / strobe on drop                                         | —                                       | No dramatic beat-drop payoff                   |
| No vignette or film grain overlay                                       | —                                       | Flat, uncinematic look                         |
| No cinematic letterbox bars                                             | —                                       | Less premium feel                              |
| No `drawtext` hook overlay (intro/outro)                                | —                                       | No hook text burned in                         |
| No slow-motion segment support                                          | —                                       | No drama on key lyric words                    |
| `captionActiveColor` hardcoded as `#FFFF00`                             | `generate.ts:253`                       | Not configurable per preset                    |

### 2.2 Caption System

| Gap                                                   | Impact                            |
| ----------------------------------------------------- | --------------------------------- |
| Only Arial font — no Impact/Oswald/Montserrat         | Less impactful subtitles          |
| 6 lyric styles in UI collapse to 2 FFmpeg styles      | UI promise not delivered          |
| `wordsPerLine` always 4, not per-preset               | Cannot do 2-word "Captions-style" |
| No pill/box highlight behind active karaoke word      | Missing CapCut staple effect      |
| No word pop-in / bounce / slide animation in ASS      | Static text only                  |
| No multi-line stagger (dim prev line, bright current) | Less engaging karaoke             |

### 2.3 Job System

| Gap                                                  | Impact                      |
| ---------------------------------------------------- | --------------------------- |
| In-memory `Map` store — lost on server restart       | All in-progress jobs vanish |
| `setImmediate()` is not a queue — no concurrency cap | CPU exhaustion on bulk runs |
| No SSE/WebSocket — client polls every 3 seconds      | Laggy progress UX           |
| No retry on transient FFmpeg failure                 | Silent data loss            |

### 2.4 Beat Detection

| Gap                                                     | Impact                     |
| ------------------------------------------------------- | -------------------------- |
| No frequency filtering — can't isolate kick from hi-hat | Imprecise onset times      |
| No "drop" detection (energy peak after buildup)         | No cinematic drop moment   |
| No downbeat grid snapping                               | Cuts can land on off-beats |

### 2.5 Frontend / UX

| Gap                                                  | Impact                                    |
| ---------------------------------------------------- | ----------------------------------------- |
| Collection cards show `🎬` emoji — no real thumbnail | Hard to identify collections              |
| No waveform / beat-marker visualization              | No musical feedback before generation     |
| No drag-and-drop clip ordering                       | Cannot control clip sequence              |
| No preset preview (mini video thumbnail)             | Presets are text labels only              |
| No safe-zone guide overlay in phone preview          | Can't see if captions are in UI-safe area |
| No platform multi-select preview per output          | Single phone preview only                 |

---

## 3. Proposed Effects & Enhancements

### 3.1 Beat-Synced Cuts

Use `beats.beats[]` timestamps directly as cut points instead of uniform BPM math.

```typescript
// videoAssembler.ts — replace uniform segDuration with actual beat timestamps
const cutPoints =
  strategy === "beat" && beats.beats.length > 3
    ? beats.beats.filter((t) => t < finalDuration)
    : Array.from(
        { length: Math.ceil(finalDuration / segDuration) },
        (_, i) => i * segDuration,
      );

const segPairs = cutPoints.slice(0, -1).map((t, i) => ({
  clipStart: t,
  duration: cutPoints[i + 1] - t,
}));
```

### 3.2 True RGB Glitch Transition

```bash
# RGB channel split — 100ms glitch window between two clips
ffmpeg -i segA.mp4 -i segB.mp4 \
  -filter_complex "
    [0:v]trim=end=GLITCH_START,setpts=PTS-STARTPTS[aclean];
    [0:v]trim=start=GLITCH_START,setpts=PTS-STARTPTS,
      split=3[r0][g0][b0];
    [r0]lutrgb=g=0:b=0[rc];
    [g0]lutrgb=r=0:b=0[gc];
    [b0]lutrgb=r=0:g=0,crop=in_w:in_h:4:2[bc];
    [rc]pad=in_w+4:in_h:4:0[rpad];
    [rpad][gc]blend=all_mode=addition[rg];
    [rg][bc]blend=all_mode=addition[glitch];
    [aclean][glitch][1:v]concat=n=3:v=1:a=0[vout]
  " \
  -map "[vout]" -c:v libx264 -crf 20 -an out.mp4
```

### 3.3 Zoom Punch at Beat Entry (fast scale expression)

```typescript
// filtergraph.ts — replace slow zoompan with per-clip scale expression
if (opts.zoomPunch) {
  const s = opts.zoomPunchStrength ?? 1.08;
  const punchFrames = Math.round((opts.zoomPunchDuration ?? 0.12) * fps);
  filters.push(
    `scale=` +
      `iw*'if(lt(n,${punchFrames}),${s}-${(s - 1).toFixed(3)}*n/${punchFrames},1)':` +
      `ih*'if(lt(n,${punchFrames}),${s}-${(s - 1).toFixed(3)}*n/${punchFrames},1)'` +
      `:eval=frame,` +
      `crop=${opts.width}:${opts.height}:(iw-${opts.width})/2:(ih-${opts.height})/2`,
  );
}
```

### 3.4 Flash Frame on Drop

```bash
# White flash decaying over 120ms — applied at drop timestamps
ffmpeg -i video.mp4 \
  -vf "
    geq=
      r='r(X,Y)+255*max(0,(0.12-(t-DROP_T))/0.12)':
      g='g(X,Y)+255*max(0,(0.12-(t-DROP_T))/0.12)':
      b='b(X,Y)+255*max(0,(0.12-(t-DROP_T))/0.12)'
  " \
  -c:v libx264 -crf 20 -c:a copy out.mp4
```

### 3.5 Vignette + Film Grain

```typescript
// filtergraph.ts — new aesthetic layer
if (opts.vignetteStrength) {
  filters.push(
    `vignette=angle=${(opts.vignetteStrength * Math.PI) / 2}:mode=backward`,
  );
}
if (opts.grainStrength) {
  filters.push(`noise=alls=${opts.grainStrength}:allf=t+u`);
}
```

### 3.6 Cinematic Letterbox Bars

```typescript
if (opts.cinematicBars) {
  const barH = Math.round(height * 0.115); // 2.35:1 crop simulation
  filters.push(
    `drawbox=x=0:y=0:w=${width}:h=${barH}:color=black:t=fill,` +
      `drawbox=x=0:y=${height - barH}:w=${width}:h=${barH}:color=black:t=fill`,
  );
}
```

### 3.7 Karaoke Pill Highlight (ASS Layer 2)

Add a `BorderStyle=3` (box) style layer underneath the karaoke text layer:

```
[V4+ Styles]
Style: KaraokeBox,Arial,72,&H00000000&,&H0000FFFF&,&H00FFFF00&,&H99000000&,-1,0,0,0,100,100,2,0,3,2,0,2,50,50,160,1
Style: Karaoke,Arial,72,&H00FFFFFF&,&H0000FFFF&,&H00000000&,&H80000000&,-1,0,0,0,100,100,2,0,1,5,2,2,50,50,160,1

[Events]
Dialogue: 1,START,END,KaraokeBox,,0,0,0,,{\kf50}word1 {\kf45}word2
Dialogue: 0,START,END,Karaoke,,0,0,0,,{\kf50}word1 {\kf45}word2
```

### 3.8 Hook Text Overlay (drawtext + animation)

```bash
# Pop-in hook text at video start
ffmpeg -i video.mp4 \
  -vf "
    drawtext=
      text='Watch till the end 👀':
      fontsize=72:fontcolor=white:
      borderw=5:bordercolor=black:
      x=(w-text_w)/2:y=h*0.12:
      alpha='if(lt(t,0.15),t/0.15,if(lt(t,3),1,(3.3-t)/0.3))':
      y='h*0.12+h*0.08*(1-min(t/0.15,1))':
      enable='between(t,0,3.3)'
  " \
  -c:v libx264 -crf 20 -c:a copy out.mp4
```

### 3.9 Slow-Motion on Key Lyric Words

```bash
# 0.5x speed with motion-compensated interpolation
ffmpeg -i clip.mp4 \
  -vf "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc,setpts=2.0*PTS,fps=30" \
  -af "atempo=0.5" \
  slow_clip.mp4
```

### 3.10 Enhanced Color Grades

| Grade         | FFmpeg String                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `teal_orange` | `curves=r='0/0 128/148 255/255':g='0/0 128/120 255/230':b='0/0 128/95 255/200',eq=saturation=1.3:contrast=1.1` |
| `film_noir`   | `hue=s=0.2,eq=contrast=1.6:brightness=-0.1,curves=all='0/0 100/20 255/240'`                                    |
| `neon_glow`   | `eq=saturation=2.2:contrast=1.2:gamma=0.85,unsharp=luma_msize_x=7:luma_msize_y=7:luma_amount=1.5`              |

---

## 4. DB / Schema Changes

### New Tables

```sql
-- Persist jobs across server restarts
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'queued',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  step           TEXT,
  progress       INTEGER DEFAULT 0,
  total_variants INTEGER DEFAULT 1,
  done_variants  INTEGER DEFAULT 0,
  error          TEXT,
  phases_skipped TEXT  -- JSON array
);

CREATE TABLE IF NOT EXISTS job_outputs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  variant        INTEGER NOT NULL,
  platform       TEXT NOT NULL,
  style          TEXT,
  preset_id      TEXT,
  final_duration REAL,
  video_url      TEXT,
  caption_url    TEXT,
  thumb_url      TEXT
);

-- Cache ffprobe results per clip to avoid repeated probing
CREATE TABLE IF NOT EXISTS clip_metadata (
  clip_path    TEXT PRIMARY KEY,
  duration     REAL,
  width        INTEGER,
  height       INTEGER,
  fps          REAL,
  has_audio    INTEGER DEFAULT 0,
  thumb_path   TEXT,
  extracted_at INTEGER
);

-- Track all completed exports for history page
CREATE TABLE IF NOT EXISTS exports (
  id            TEXT PRIMARY KEY,
  job_id        TEXT,
  music_id      TEXT,
  collection_id TEXT,
  preset_id     TEXT,
  platform      TEXT,
  duration      REAL,
  created_at    INTEGER
);
```

### Existing Table Additions

```sql
ALTER TABLE tracks ADD COLUMN energy_level  REAL;     -- 0–1, average RMS
ALTER TABLE tracks ADD COLUMN drop_times    TEXT;     -- JSON: [12.4, 34.1, ...]

ALTER TABLE presets ADD COLUMN thumbnail_url TEXT;
ALTER TABLE presets ADD COLUMN tags          TEXT;    -- JSON: ["dark","viral"]
ALTER TABLE presets ADD COLUMN use_count     INTEGER DEFAULT 0;

ALTER TABLE hooks ADD COLUMN category    TEXT;        -- "intro"|"outro"|"cta"
ALTER TABLE hooks ADD COLUMN animation   TEXT;        -- "pop"|"slide"|"fade"
ALTER TABLE hooks ADD COLUMN use_count   INTEGER DEFAULT 0;

ALTER TABLE collections ADD COLUMN thumbnail_path    TEXT;
ALTER TABLE collections ADD COLUMN avg_clip_duration REAL;
ALTER TABLE collections ADD COLUMN tags              TEXT; -- JSON
```

### Extended Preset Config JSON

```json
{
  "captionStyle": "karaoke",
  "captionColor": "#FFFFFF",
  "captionActiveColor": "#FFFF00",
  "captionFont": "Impact",
  "captionWordsPerLine": 3,
  "captionAnimation": "pop",
  "captionBoxBackground": true,
  "captionBoxColor": "#000000",
  "captionBoxOpacity": 0.5,
  "captionPosition": "bottom",

  "clipCutStrategy": "beat",
  "beatDivision": 1,
  "transition": "glitch_rgb",
  "transitionDuration": 0.08,

  "zoomPunch": true,
  "zoomPunchStrength": 1.08,
  "zoomPunchDuration": 0.12,

  "speedVariation": true,
  "slowmoKeyword": true,
  "slowmoKeywordRegex": "\\b(go|drop|yeah)\\b",

  "colorGrade": "dark_contrast",
  "grainStrength": 12,
  "vignetteStrength": 0.4,
  "chromaticAberration": true,
  "flashOnDrop": true,
  "cinematicBars": false,

  "energyBasedCuts": true,
  "introHook": true,
  "introHookDuration": 3,
  "maxDuration": 25,

  "platformOverrides": {
    "shorts": { "fps": 60, "maxDuration": 30 },
    "stories": { "maxDuration": 15, "captionWordsPerLine": 2 }
  }
}
```

---

## 5. API Changes

### New / Updated Endpoints

| Method   | Path                           | Description                                        |
| -------- | ------------------------------ | -------------------------------------------------- |
| `GET`    | `/api/jobs`                    | Now reads from SQLite, not memory                  |
| `GET`    | `/api/jobs/:id/stream`         | **NEW** — SSE real-time progress stream            |
| `GET`    | `/api/clips/:id/metadata`      | **NEW** — ffprobe cache per collection             |
| `POST`   | `/api/clips/:id/thumbnails`    | **NEW** — extract first-frame thumbnails           |
| `GET`    | `/api/presets/:id/preview`     | **NEW** — 3s preview render for preset card        |
| `POST`   | `/api/collections/:id/analyze` | **NEW** — run ffprobe on all clips, store metadata |
| `DELETE` | `/api/exports/:id`             | **NEW** — delete export file + DB record           |
| `GET`    | `/api/exports`                 | **NEW** — full generation history                  |

### Updated `POST /api/generate-batch` Payload

```json
{
  "music_id": "abc123",
  "clips_id": "def456",
  "platforms": ["tiktok", "reels", "shorts"],
  "preset_id": "viral_hype_v2",
  "caption_color": "#FFFFFF",
  "caption_active_color": "#FFFF00",
  "mood_id": "hype",
  "duration_mode": "auto",
  "custom_duration": null,
  "batch_count": 3,
  "segments": null,
  "hook_text": "Watch till the end 👀",
  "hook_animation": "pop",
  "hook_position": "top",
  "beat_division": 1,
  "seed": 42
}
```

### SSE Endpoint Implementation

```typescript
// backend/src/routes/generate.ts
generateRouter.get("/jobs/:id/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = () => {
    const job = getJob(req.params.id);
    if (!job) {
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    if (job.status === "done" || job.status === "error") {
      clearInterval(timer);
      res.end();
    }
  };

  send();
  const timer = setInterval(send, 800);
  req.on("close", () => clearInterval(timer));
});
```

---

## 6. FFmpeg Pipeline Upgrades

### 6.1 Full Updated `buildClipFilter()` Signature

```typescript
export interface ClipFilterOptions {
  width: number;
  height: number;
  fps: number;
  segDuration?: number;
  segmentIndex?: number;

  // Existing
  zoomPunch?: boolean;
  speedVariation?: boolean;
  colorGrade?: ColorGrade;

  // New
  zoomPunchStrength?: number; // default 1.08
  zoomPunchDuration?: number; // seconds, default 0.12
  isSlowmo?: boolean;
  grainStrength?: number; // 0-30, default off
  vignetteStrength?: number; // 0-1, default off
  chromaticAberration?: boolean;
  cinematicBars?: boolean;
  flashFrame?: boolean;
}
```

### 6.2 New Transition Types to Add

| ID           | Description                           | FFmpeg Approach                      |
| ------------ | ------------------------------------- | ------------------------------------ |
| `glitch_rgb` | RGB channel split + horizontal offset | `lutrgb` + `blend=addition` + `pad`  |
| `zoom_cut`   | Hard cut with zoom punch              | `scale` expression on first 8 frames |
| `flash_cut`  | White flash on cut                    | `geq` overlay at `t=0`               |
| `squeezev`   | Vertical squeeze xfade                | `xfade=transition=squeezev`          |
| `zoomin`     | Zoom-in xfade                         | `xfade=transition=zoomin`            |
| `hblur`      | Horizontal blur xfade                 | `xfade=transition=hblur`             |

### 6.3 Beat-Synced Assembly Flow (updated)

```
beats.beats[] = [0.0, 0.5, 1.0, 1.5, 2.0, ...]  (actual onset timestamps)
         │
         ▼
buildBeatSegments()  →  [{clipStart: 0.0, duration: 0.5}, {clipStart: 0.5, duration: 0.5}, ...]
         │
         ▼
trimAndCrop() per segment  (each clip trimmed to exactly one beat interval)
         │
         ▼
concatWithTransitions()    (xfade or glitch_rgb between each segment)
         │
         ▼
applyDropFlash()           (white flash overlaid at drop timestamps)
         │
         ▼
overlayTextHook()          (drawtext intro hook if preset.introHook)
         │
         ▼
muxAudio()
         │
         ▼
burnCaptions()             (karaoke pill highlight via dual ASS layers)
```

### 6.4 Drop Detection in `beatDetection.ts`

```typescript
// Add to BeatResult
export interface BeatResult {
  bpm: number;
  beats: number[];
  drops: number[]; // NEW — timestamps of high-energy onset peaks
}

// In detectFromPCM() — find top 10% energy onsets as drop candidates
function findDrops(
  energy: number[],
  onsets: number[],
  sampleRate: number,
  frameSize: number,
): number[] {
  if (onsets.length < 4) return [];
  const onsetEnergies = onsets.map((t) => {
    const frame = Math.floor((t * sampleRate) / frameSize);
    return { t, e: energy[frame] ?? 0 };
  });
  const sorted = [...onsetEnergies].sort((a, b) => b.e - a.e);
  const threshold = sorted[Math.floor(sorted.length * 0.1)].e; // top 10%
  return onsetEnergies
    .filter((o) => o.e >= threshold)
    .map((o) => o.t)
    .sort((a, b) => a - b);
}
```

---

## 7. Frontend Integration

### 7.1 Replace Polling with SSE

```typescript
// web/src/lib/api.ts
export function watchJob(
  jobId: string,
  onUpdate: (job: JobMetadata) => void,
  onDone: (job: JobMetadata) => void,
): () => void {
  const es = new EventSource(`${API_BASE}/api/jobs/${jobId}/stream`);
  es.onmessage = (e) => {
    const job: JobMetadata = JSON.parse(e.data);
    onUpdate(job);
    if (job.status === "done" || job.status === "error") {
      onDone(job);
      es.close();
    }
  };
  return () => es.close();
}

// In Studio.tsx — replace setInterval with:
useEffect(() => {
  if (!batchJobId) return;
  return watchJob(
    batchJobId,
    (job) => setBatchJob(job),
    (job) => setBatchJob(job),
  );
}, [batchJobId]);
```

### 7.2 Collection Thumbnail in Cards

```tsx
// CollectionCard — replace 🎬 emoji
function CollectionCard({ collection, ... }) {
  const thumbUrl = collection.thumbnailUrl
    ? absoluteUrl(collection.thumbnailUrl)
    : null;
  return (
    <button ...>
      <div style={{ aspectRatio: "9/16", overflow: "hidden" }}>
        {thumbUrl ? (
          <img src={thumbUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span>🎬</span>
        )}
      </div>
    </button>
  );
}
```

### 7.3 Beat Marker Timeline

```tsx
function TimelineStrip({ segments, beats, totalDuration }) {
  return (
    <div
      style={{
        position: "relative",
        height: 28,
        background: "var(--bg-4)",
        borderRadius: 6,
      }}
    >
      {/* Orange tick per beat */}
      {beats?.map((t, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${(t / totalDuration) * 100}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: "rgba(249,115,22,0.55)",
          }}
        />
      ))}
      {/* Purple word segment blocks */}
      {segments.slice(0, 20).map((seg, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${(seg.start / totalDuration) * 100}%`,
            width: `${((seg.end - seg.start) / totalDuration) * 100}%`,
            height: "100%",
            background:
              i % 2 === 0 ? "rgba(139,92,246,0.45)" : "rgba(249,115,22,0.35)",
          }}
          title={seg.text}
        />
      ))}
    </div>
  );
}
```

### 7.4 Platform Safe-Zone Overlay

```tsx
const SAFE_ZONES = {
  tiktok: { bottom: 160, top: 60, right: 80 },
  reels: { bottom: 200, top: 60, right: 80 },
  shorts: { bottom: 120, top: 60, right: 80 },
  stories: { bottom: 300, top: 80, right: 40 },
};

function SafeZoneOverlay({ platform }: { platform: string }) {
  const z = SAFE_ZONES[platform as keyof typeof SAFE_ZONES];
  if (!z) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          bottom: `${z.bottom / 19.2}%`,
          left: "5%",
          right: `${z.right / 10.8}%`,
          borderTop: "1px dashed rgba(255,165,0,0.45)",
        }}
      />
    </div>
  );
}
```

### 7.5 Preset Cards with Mini Preview

```tsx
function PresetCard({ preset, selected, onSelect }) {
  return (
    <button
      onClick={onSelect}
      style={{
        border: `2px solid ${selected ? "var(--purple)" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        overflow: "hidden",
        background: selected ? "var(--purple-dim)" : "var(--bg-3)",
        cursor: "pointer",
      }}
    >
      {preset.thumbnailUrl ? (
        <video
          src={absoluteUrl(preset.thumbnailUrl)}
          autoPlay
          loop
          muted
          playsInline
          style={{ width: "100%", height: 80, objectFit: "cover" }}
        />
      ) : (
        <div
          style={{
            height: 80,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: `${preset.config.captionColor}18`,
            fontSize: "0.7rem",
            color: preset.config.captionColor,
          }}
        >
          {preset.config.colorGrade ?? "clean"}
        </div>
      )}
      <p
        style={{
          fontSize: "0.75rem",
          fontWeight: 700,
          padding: "0.4rem 0.5rem",
        }}
      >
        {preset.name}
      </p>
    </button>
  );
}
```

---

## 8. Priority Roadmap

### Legend

- 🔴 Critical (broken / misleading behavior)
- 🟠 High impact, low effort — ship immediately
- 🟡 High impact, medium effort — next sprint
- 🟢 Medium impact — polish sprint
- ⚪ Nice-to-have / future
- ✅ Done

---

### Week 1 — Quick Wins & Critical Fixes

| #   | Task                                                                                  | Priority | Effort |
| --- | ------------------------------------------------------------------------------------- | -------- | ------ |
| 1   | **Use `beats.beats[]` timestamps for clip cuts** (replace uniform math)               | ✅       | Low    |
| 2   | **Wire up `energyBasedCuts`** in `videoAssembler.ts` (currently dead code)            | ✅       | Low    |
| 3   | **Make `captionActiveColor` configurable** per preset (currently hardcoded `#FFFF00`) | ✅       | Low    |
| 4   | **Persist jobs to SQLite** — replace in-memory `Map` with DB-backed store             | ✅       | Low    |
| 5   | **SSE job progress** — replace 3s client polling                                      | ✅       | Low    |
| 6   | **Collection card thumbnails** — extract first-frame on collection save               | ✅       | Low    |
| 7   | **Add `teal_orange`, `neon_glow`, `film_noir` color grades**                          | ✅       | Low    |
| 8   | **Add `squeezev`, `zoomin`, `hblur` to xfade transition map**                         | ✅       | Low    |

---

### Week 2 — Core Viral Effects

| #   | Task                                                                        | Priority | Effort |
| --- | --------------------------------------------------------------------------- | -------- | ------ |
| 9   | **RGB glitch transition** (`glitch_rgb`) — real chromatic aberration split  | ✅       | Medium |
| 10  | **Zoom punch at beat entry** — replace `zoompan` with fast scale expression | ✅       | Medium |
| 11  | **Flash frame on beat drop** — `geq` overlay at drop timestamps             | ✅       | Medium |
| 12  | **Drop detection** in `beatDetection.ts` — populate `drops[]` array         | ✅       | Medium |
| 13  | **Karaoke pill highlight** — dual ASS layer (box + text)                    | ✅       | Medium |
| 14  | **`captionBoxBackground` preset option**                                    | ✅       | Low    |
| 15  | **`captionWordsPerLine` per preset**                                        | ✅       | Low    |
| 16  | **Film grain + vignette overlay** in `buildClipFilter()`                    | ✅       | Low    |
| 17  | **Motion blur on `setpts` speed-up** (`tblend=average`)                     | ✅       | Low    |

---

### Week 3 — UX & Polish

| #   | Task                                                                  | Priority | Effort |
| --- | --------------------------------------------------------------------- | -------- | ------ |
| 18  | **Hook text overlay** (`drawtext` + `pop/slide/fade` animation)       | ✅       | Medium |
| 19  | **Beat marker visualization** in Timeline strip                       | ✅       | Medium |
| 20  | **Preset preview thumbnail renders** (`GET /api/presets/:id/preview`) | ✅       | Medium |
| 21  | **Cinematic letterbox bars** preset option                            | ✅       | Low    |
| 22  | **Platform safe-zone overlay** in phone preview                       | ✅       | Low    |
| 23  | **Clip metadata cache** — `ffprobe` results in `clip_metadata` table  | ✅       | Medium |
| 24  | **Reproducible renders** via `seed` param (deterministic shuffle)     | ✅       | Low    |
| 25  | **Export history page** — `GET /api/exports` + frontend list          | ✅       | Medium |

---

### Week 4 — Scalability & Advanced Features

| #   | Task                                                                          | Priority | Effort |
| --- | ----------------------------------------------------------------------------- | -------- | ------ |
| 26  | **Job concurrency queue** — max 2 parallel FFmpeg processes                   | ✅       | Medium |
| 27  | **Slow-motion on keyword segments** — `minterpolate + setpts=2.0`             | ✅       | High   |
| 28  | **One-click multi-platform batch** — TikTok + Reels + Shorts in one click     | ✅       | Low    |
| 29  | **Custom font bundling** — ship Impact/Oswald/Montserrat in `/assets/fonts/`  | ✅       | Medium |
| 30  | **`captionAnimation` in ASS** — `\fscx` scale keyframes for pop/bounce effect | ✅       | High   |

---

### Week 5 — Advanced & Future

| #   | Task                                                                          | Priority | Effort |
| --- | ----------------------------------------------------------------------------- | -------- | ------ |
| 31  | **Beat-grid word timestamp snapping** — snap Whisper segments to nearest beat | ⚪       | High   |
| 32  | **Drag-and-drop clip ordering** in collection editor                          | ✅       | High   |
| 33  | **Freeze frame on drop** (duplicate single frame × N frames + flash)          | ✅       | High   |
| 34  | **Energy-based clip selection** — prefer clips with motion/action             | ⚪       | High   |
| 35  | **BullMQ / Redis job queue** — production-grade concurrency + retry           | ⚪       | High   |
| 36  | **Waveform audio visualizer** in Studio (using Web Audio API)                 | ⚪       | High   |

---

## Quick Reference — Immediate Code Changes

### Fix 1: Beat-synced cuts (4 lines changed)

```typescript
// videoAssembler.ts — replace lines ~222-228
const cutPoints =
  strategy === "beat" && beats.beats.length > 3
    ? beats.beats.filter((t) => t < finalDuration)
    : Array.from(
        { length: Math.ceil(finalDuration / segDuration) },
        (_, i) => i * segDuration,
      );

const segPairs = cutPoints.slice(0, -1).map((t, i) => ({
  start: t,
  duration: Math.max(0.2, cutPoints[i + 1] - t),
}));
```

### Fix 2: Wire energyBasedCuts (1 line changed)

```typescript
// videoAssembler.ts — in strategy resolution block
const strategy = preset?.energyBasedCuts
  ? "beat" // force beat strategy when energyBasedCuts is on
  : (preset?.clipCutStrategy ?? "beat");
```

### Fix 3: Configurable activeColor (1 line changed)

```typescript
// generate.ts — in karaoke branch
activeColor: req.body.caption_active_color ?? preset?.config.captionActiveColor ?? "#FFFF00",
```

### Fix 4: Add 3 new xfade transitions (3 lines added)

```typescript
// filtergraph.ts — in xfadeMap
squeezev: "squeezev",
zoomin:   "zoomin",
hblur:    "hblur",
```

---

_Generated: 2026-02-26 — BeatForge Architecture Analysis_
