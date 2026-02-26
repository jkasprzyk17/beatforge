import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { uploadRouter } from "./routes/upload.js";
import { generateRouter } from "./routes/generate.js";
import { transcribeRouter } from "./routes/transcribe.js";
import { collectionsRouter } from "./routes/collections.js";
import { hooksRouter } from "./routes/hooks.js";
import { presetsRouter } from "./routes/presets.js";
import { DIRS, ensureDirs } from "./utils/helpers.js";
import { seedDefaultPresets } from "./services/presetService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8000);

ensureDirs();
seedDefaultPresets();

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
app.use("/api", transcribeRouter);
app.use("/api", collectionsRouter);
app.use("/api", hooksRouter);
app.use("/api", presetsRouter);

// ── Health ───────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.listen(PORT, () => {
  console.log(`\n🚀  BeatForge API  →  http://localhost:${PORT}\n`);
});
