# BeatForge AI 🎬🥁

Generate beat-synced short vertical videos (20 s, 9:16) from a folder of 2–5 second clips, automatically cut and synced to an uploaded music track — with AI-generated captions in three visual styles.

---

## Architecture

```
BeatForge AI
├── app/                     ← FastAPI backend (Python)
│   ├── main.py              ← App entry point, CORS, routers
│   ├── api/
│   │   ├── upload.py        ← POST /upload-music, /upload-clips
│   │   └── generate.py      ← POST /generate-preview, /generate-batch
│   │                           GET  /download-video, /jobs
│   ├── services/
│   │   ├── beat_detection.py  ← librosa beat analysis
│   │   ├── video_assembler.py ← ffmpeg clip assembly
│   │   └── captions.py        ← Whisper transcription + SRT + burn
│   └── utils/
│       └── helpers.py         ← paths, metadata JSON, ID generation
│
├── web/                     ← Vite + React + TypeScript frontend
│   ├── src/
│   │   ├── App.tsx           ← 3-step wizard (Upload → Preview → Batch)
│   │   ├── components/
│   │   │   ├── UploadForm.tsx     ← Music + clip upload + style picker
│   │   │   ├── VideoPreview.tsx   ← 5-second preview player
│   │   │   └── BatchControls.tsx  ← Batch start + polling + download grid
│   │   ├── lib/
│   │   │   └── api.ts        ← Typed fetch wrappers for all endpoints
│   │   └── styles/
│   │       └── global.css    ← Design system tokens + utility classes
│   └── .env.local            ← VITE_API_URL=http://localhost:8000
│
├── clips/                   ← Uploaded clip files (auto-created)
├── music/                   ← Uploaded music files (auto-created)
├── exports/                 ← Rendered videos, SRT files, metadata JSON
├── requirements.txt
└── README.md
```

---

## Prerequisites

| Tool    | Minimum Version | Notes              |
| ------- | --------------- | ------------------ |
| Python  | 3.11+           |                    |
| Node.js | 18+             |                    |
| ffmpeg  | 6+              | Must be on `$PATH` |
| ffprobe | 6+              | Ships with ffmpeg  |

### Install ffmpeg

```bash
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt update && sudo apt install -y ffmpeg

# Windows — download from https://ffmpeg.org/download.html and add to PATH
```

---

## Quick Start — Local Development

### 1. Clone / open the project

```bash
cd /path/to/BeatForge
```

### 2. Backend setup

```bash
# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate          # macOS / Linux
# .venv\Scripts\activate           # Windows

# Install Python dependencies
pip install -r requirements.txt

# Start the API server with hot-reload
uvicorn app.main:app --reload --port 8000
# → http://localhost:8000
# → Swagger docs: http://localhost:8000/docs
```

> **First run note:** Whisper will download the `base` model (~74 MB) on the first transcription request. Set the env var `WHISPER_MODEL=small` (or `medium`) for higher accuracy at the cost of speed.

### 3. Frontend setup

```bash
cd web
npm install
npm run dev
# → http://localhost:5173
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## API Reference

All endpoints are prefixed with `/api`.

| Method | Path                           | Description                                                             |
| ------ | ------------------------------ | ----------------------------------------------------------------------- |
| `POST` | `/api/upload-music`            | Upload a `.mp3`/`.wav` track. Returns `music_id`.                       |
| `POST` | `/api/upload-clips`            | Upload 1–20 video clips. Returns `clips_id`.                            |
| `POST` | `/api/generate-preview`        | Render 360×640 preview (5 s default). Returns `job_id` + `preview_url`. |
| `POST` | `/api/generate-batch`          | Queue full-res batch (background task). Returns `job_id`.               |
| `GET`  | `/api/download-video/{job_id}` | Stream finished mp4 to browser.                                         |
| `GET`  | `/api/jobs`                    | List all completed jobs.                                                |
| `GET`  | `/api/jobs/{job_id}`           | Poll job status and get output URLs.                                    |
| `GET`  | `/health`                      | Liveness probe.                                                         |

Interactive docs → [http://localhost:8000/docs](http://localhost:8000/docs)

---

## Output Files

For each batch job, BeatForge AI produces (inside `exports/`):

| File                          | Description                                        |
| ----------------------------- | -------------------------------------------------- |
| `<job>_bold_center_v1.mp4`    | 1080×1920 video with bold white centred captions   |
| `<job>_karaoke_v1.mp4`        | 1080×1920 video with yellow karaoke-style captions |
| `<job>_minimal_clean_v1.mp4`  | 1080×1920 video with minimal pill captions         |
| `<job>_*.srt`                 | Subtitle file for each video                       |
| `exports/metadata/<job>.json` | Clips used, BPM, timestamps, style, status         |

---

## Caption Styles

| Style ID        | Description                                                           |
| --------------- | --------------------------------------------------------------------- |
| `bold_center`   | Large white bold Arial text, centred, thick black outline             |
| `karaoke`       | Yellow primary / white secondary highlight, simulates word-level sync |
| `minimal_clean` | Small Helvetica text in a semi-transparent dark pill at the bottom    |

---

## Environment Variables

### Backend (`app/`)

| Variable        | Default | Description                                                     |
| --------------- | ------- | --------------------------------------------------------------- |
| `WHISPER_MODEL` | `base`  | Whisper model size (`tiny`, `base`, `small`, `medium`, `large`) |

Create a `.env` file in the project root:

```env
WHISPER_MODEL=base
```

### Frontend (`web/`)

| Variable       | Default                 | Description    |
| -------------- | ----------------------- | -------------- |
| `VITE_API_URL` | `http://localhost:8000` | Backend origin |

---

## Deployment

### Architecture: Vercel (frontend) + AWS (backend)

```
Browser → Vercel CDN → React/Vite app
                         │
                         └──(VITE_API_URL)──→ AWS (EC2/ECS) → FastAPI
                                                                  │
                                                            /exports → S3 (optional)
```

### Vercel (frontend)

1. Push the `web/` folder (or the whole repo) to GitHub.
2. Import the project in [vercel.com](https://vercel.com/new).
3. Set **Root Directory** → `web`.
4. Add environment variable:
   | Name | Value |
   |------|-------|
   | `VITE_API_URL` | `https://your-aws-api.com` |
5. Deploy — done. Vercel auto-detects Vite and runs `npm run build`.

> The `vercel.json` already handles SPA routing (all paths → `index.html`).

---

### AWS — Option A: EC2 (simplest)

```bash
# On your EC2 instance (Amazon Linux 2 / Ubuntu)
sudo apt update && sudo apt install -y python3.11 python3.11-venv ffmpeg git

git clone https://github.com/you/beatforge.git && cd beatforge

python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: set ALLOWED_ORIGINS to your Vercel URL
nano .env

# Run with gunicorn (production)
gunicorn app.main:app \
  --workers 2 \
  --worker-class uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:8000 \
  --timeout 300 \
  --daemon
```

Add a `systemd` service or `nginx` reverse proxy as needed.

---

## Performance Tips

- Use `WHISPER_MODEL=tiny` for the fastest transcription (lower accuracy).
- Set `--workers 2` (or more) in the uvicorn command for multi-core throughput.
- Place `clips/` and `exports/` on an SSD to speed up ffmpeg I/O.
- For batch jobs, ffmpeg uses `-preset ultrafast` for intermediate segments and `-preset fast` for the final output — adjust in `video_assembler.py` as needed.

---

## License

MIT
