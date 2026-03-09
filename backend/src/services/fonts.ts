/**
 * Font registry — maps BeatForge font IDs to:
 *   • family name   (used in ASS Style "Fontname" field and drawtext `font=`)
 *   • bundled file  (TTF placed in backend/assets/fonts/ by download-fonts.sh)
 *
 * Resolution order for each render:
 *   1. If the TTF file exists in assets/fonts/ → FFmpeg uses it via
 *      `subtitles=file.ass:fontsdir=/abs/path` (libass) or `fontfile=` (drawtext).
 *   2. Otherwise → libass / drawtext fall back to the system font by family name.
 *      Impact and Arial are system-installed on macOS/Windows and work without
 *      bundling.  Oswald and Montserrat require either bundling or prior
 *      installation to render correctly on headless servers.
 *
 * Run `npm run setup:fonts` (or `bash scripts/download-fonts.sh`) once to
 * populate assets/fonts/ from the Google Fonts / system font sources.
 */

import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Font registry ─────────────────────────────────────────

export type FontName = "impact" | "oswald" | "montserrat" | "arial";

interface FontSpec {
  /** CSS / ASS family name (exact match required by libass). */
  family: string;
  /** TTF filename expected inside FONTS_DIR. */
  file: string;
}

export const FONT_REGISTRY: Record<FontName, FontSpec> = {
  impact:     { family: "Impact",     file: "impact.ttf" },
  oswald:     { family: "Oswald",     file: "oswald-bold.ttf" },
  montserrat: { family: "Montserrat", file: "montserrat-bold.ttf" },
  arial:      { family: "Arial",      file: "arial.ttf" },
};

/**
 * Absolute path to the bundled fonts directory.
 * Files are placed here by `scripts/download-fonts.sh`.
 */
export const FONTS_DIR = path.resolve(__dirname, "../../assets/fonts");

// ── Helpers ───────────────────────────────────────────────

/**
 * Returns the font family name string for use in ASS Style "Fontname" and
 * drawtext `font=` option.  Falls back to "Arial" for unknown names.
 */
export function getFontFamily(name: FontName | undefined): string {
  if (!name) return "Arial";
  return FONT_REGISTRY[name]?.family ?? "Arial";
}

/**
 * Returns the absolute path to the bundled TTF file if it exists on disk, or
 * null when the font hasn't been downloaded yet (graceful degradation).
 */
export function getBundledFontPath(name: FontName | undefined): string | null {
  if (!name) return null;
  const spec = FONT_REGISTRY[name];
  if (!spec) return null;
  const p = path.join(FONTS_DIR, spec.file);
  return fs.existsSync(p) ? p : null;
}

/**
 * Returns the drawtext filter option fragment (no leading/trailing `:`) for
 * the given font:
 *   • When the TTF file is bundled  → `fontfile=/abs/path/to/font.ttf`
 *   • When not bundled              → `font=FamilyName`   (uses system font)
 *
 * Caller is responsible for joining this fragment with `:` between other
 * drawtext options.
 */
export function drawtextFontOpt(name: FontName | undefined): string {
  const bundled = getBundledFontPath(name);
  if (bundled) {
    // Forward-slashes are safe on all platforms; colons in Windows paths
    // would break drawtext option parsing — not an issue here since assets/
    // lives under the workspace which has no drive-letter colon.
    return `fontfile=${bundled.replace(/\\/g, "/")}`;
  }
  return `font=${getFontFamily(name)}`;
}

/**
 * Escape a path for use inside an FFmpeg filter option value (e.g. fontsdir=…).
 * On Windows, the colon in "C:" is interpreted by libass as an option separator,
 * so we escape it as "C\:" so the full path is passed as one value.
 */
export function escapePathForFilter(dirPath: string): string {
  const withForwardSlash = dirPath.replace(/\\/g, "/");
  const colonIndex = withForwardSlash.indexOf(":");
  if (colonIndex !== -1) {
    return withForwardSlash.slice(0, colonIndex) + "\\:" + withForwardSlash.slice(colonIndex + 1);
  }
  return withForwardSlash;
}

/**
 * Returns the `:fontsdir=…` suffix to append to an FFmpeg subtitles filter
 * when at least one TTF is present in the bundled fonts directory.
 *
 * Returns an empty string when the directory is empty / doesn't exist —
 * libass then searches only system fonts, which is fine for Impact / Arial.
 *
 * On Windows, we never pass fontsdir: libass misparses paths that contain
 * a drive letter (C:) in the filter option string, leading to "Unable to open"
 * or "Permission denied". Skipping fontsdir on Windows lets libass use system
 * fonts (Arial, Impact work out of the box).
 */
export function subtitlesFontsDirOpt(): string {
  if (process.platform === "win32") {
    return "";
  }
  try {
    const files = fs.readdirSync(FONTS_DIR).filter((f) => /\.(ttf|otf)$/i.test(f));
    if (files.length > 0) {
      return `:fontsdir=${escapePathForFilter(FONTS_DIR)}`;
    }
  } catch {
    // directory doesn't exist yet
  }
  return "";
}
