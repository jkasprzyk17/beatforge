import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { uploadRouter } from "./routes/upload.js";
import { generateRouter } from "./routes/generate.js";
import { transcribeRouter } from "./routes/transcribe.js";
import { collectionsRouter } from "./routes/collections.js";
import { hooksRouter } from "./routes/hooks.js";
import { presetsRouter } from "./routes/presets.js";
import { massGenerateRouter } from "./routes/massGenerate.js";
import { compositionsRouter } from "./routes/compositions.js";
import { DIRS, ensureDirs } from "./utils/helpers.js";
import { seedDefaultPresets } from "./services/presetService.js";
import { pruneClipMetaCache } from "./utils/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8000);

ensureDirs();
seedDefaultPresets();
const staleCount = pruneClipMetaCache();
if (staleCount > 0) console.log(`[clip-cache] Pruned ${staleCount} stale entries`);

// ── GPU encoder auto-detection ────────────────────────────

// Actually test-encode 1 frame — checking `ffmpeg -encoders` is not enough
// because the encoder can be compiled in but fail at runtime (e.g. h264_nvenc
// listed on a machine that has no NVIDIA CUDA drivers → nvcuda.dll error).
function testEncoder(enc: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-f", "lavfi", "-i", "color=black:s=128x128:r=1",
        "-vframes", "1",
        "-c:v", enc,
        "-f", "null", "-",
      ],
      { stdio: "ignore" },
    );
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

async function detectBestEncoder(): Promise<string> {
  // Priority: NVIDIA → AMD → Intel → CPU
  const candidates = ["h264_nvenc", "h264_amf", "h264_qsv"] as const;
  for (const enc of candidates) {
    const ok = await testEncoder(enc);
    if (ok) return enc;
  }
  return "libx264";
}

const rawEncoder = (process.env.VIDEO_ENCODER ?? "libx264").toLowerCase();
if (rawEncoder === "auto") {
  const best = await detectBestEncoder();
  process.env.VIDEO_ENCODER = best;
  console.log(`\n🎮  GPU auto-detect → using encoder: ${best}`);
} else {
  console.log(`\n🎬  Encoder: ${rawEncoder}`);
}

const app = express();

// ── CORS ─────────────────────────────────────────────────
const origins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());
app.use(cors({ origin: origins, credentials: true }));

app.use(express.json());

// ── Static exports ────────────────────────────────────────
app.use("/exports", express.static(DIRS.exports));

// ── Routes ───────────────────────────────────────────────
app.use("/api", uploadRouter);
app.use("/api", generateRouter);
app.use("/api", massGenerateRouter);
app.use("/api", transcribeRouter);
app.use("/api", collectionsRouter);
app.use("/api", hooksRouter);
app.use("/api", presetsRouter);
app.use("/api", compositionsRouter);

// ── Health ───────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ── Frontend (produkcja / paczka Windows) ─────────────────
const webDist = path.join(__dirname, "..", "web-dist");
if (process.env.NODE_ENV === "production" && fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`\n🚀  BeatForge API  →  http://localhost:${PORT}\n`);
});
