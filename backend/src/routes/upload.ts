import { Router } from 'express';
import multer from 'multer';
import path   from 'node:path';
import fs     from 'node:fs';
import { DIRS, newId, musicFile } from '../utils/helpers.js';
import { saveTrack, getAllTracks, deleteTrack, pruneClipMetaCache } from '../utils/db.js';

export const uploadRouter = Router();

// ── Multer storage factories ──────────────────────────────

function musicStorage() {
  return multer.diskStorage({
    destination(_req, _file, cb) {
      const id  = newId();
      const dir = path.join(DIRS.music, id);
      fs.mkdirSync(dir, { recursive: true });
      // stash the id on the request so the handler can read it
      (_req as any)._musicId = id;
      cb(null, dir);
    },
    filename(_req, file, cb) { cb(null, file.originalname); },
  });
}

function clipsStorage() {
  return multer.diskStorage({
    destination(req, _file, cb) {
      // all files in one batch share a single id
      if (!(req as any)._clipsId) {
        const id  = newId();
        const dir = path.join(DIRS.clips, id);
        fs.mkdirSync(dir, { recursive: true });
        (req as any)._clipsId = id;
      }
      cb(null, path.join(DIRS.clips, (req as any)._clipsId));
    },
    filename(_req, file, cb) { cb(null, file.originalname); },
  });
}

// ── POST /api/upload-music ────────────────────────────────

const uploadMusicMiddleware = multer({
  storage: musicStorage(),
  fileFilter(_req, file, cb) {
    cb(null, /\.(mp3|wav|aac|flac|m4a)$/i.test(file.originalname));
  },
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
}).single('file');

uploadRouter.post('/upload-music', (req, res) => {
  // Recreate middleware each request so storage creates a fresh ID
  const mw = multer({
    storage: musicStorage(),
    fileFilter(_req, file, cb) {
      cb(null, /\.(mp3|wav|aac|flac|m4a)$/i.test(file.originalname));
    },
    limits: { fileSize: 100 * 1024 * 1024 },
  }).single('file');

  mw(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const id = (req as any)._musicId as string;
    if (!id || !req.file) return res.status(400).json({ error: 'No file received' });

    saveTrack({
      id,
      filename:     req.file.filename,
      originalName: req.file.originalname,
      size:         req.file.size,
      uploadedAt:   new Date().toISOString(),
    });

    res.json({ music_id: id, filename: req.file.originalname, size: req.file.size });
  });
});

// ── GET /api/tracks ───────────────────────────────────────

uploadRouter.get('/tracks', (_req, res) => {
  res.json(getAllTracks());
});

// ── GET /api/tracks/:id/audio ─────────────────────────────

uploadRouter.get('/tracks/:id/audio', (req, res) => {
  try {
    const filePath = musicFile(req.params.id);
    const stat     = fs.statSync(filePath);
    const ext      = path.extname(filePath).toLowerCase();
    const mime: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
      '.m4a': 'audio/mp4',
    };
    const contentType = mime[ext] ?? 'audio/mpeg';

    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start     = parseInt(startStr, 10);
      const end       = endStr ? parseInt(endStr, 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   contentType,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type':   contentType,
        'Accept-Ranges':  'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err: unknown) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'Not found' });
  }
});

// ── DELETE /api/tracks/:id ────────────────────────────────

uploadRouter.delete('/tracks/:id', (req, res) => {
  const { id } = req.params;
  // Remove from db
  deleteTrack(id);
  // Remove files from disk (best-effort)
  const dir = path.join(DIRS.music, id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

// ── POST /api/upload-clips ────────────────────────────────

uploadRouter.post('/upload-clips', (req, res) => {
  const mw = multer({
    storage: clipsStorage(),
    fileFilter(_req, file, cb) {
      cb(null, /\.(mp4|mov|avi|mkv|webm)$/i.test(file.originalname));
    },
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB total
  }).array('files');

  mw(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const id = (req as any)._clipsId as string;
    const files = req.files as Express.Multer.File[];
    if (!id || !files?.length) return res.status(400).json({ error: 'No files received' });
    res.json({
      clips_id: id,
      count:    files.length,
      files:    files.map(f => ({ name: f.originalname, size: f.size })),
    });
  });
});

// ── DELETE /api/clip-metadata/stale ──────────────────────
// Removes clip_metadata rows whose source files no longer exist.
// Lightweight — just stat() calls, no FFmpeg.

uploadRouter.delete('/clip-metadata/stale', (_req, res) => {
  try {
    const removed = pruneClipMetaCache();
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
