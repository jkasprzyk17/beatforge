#!/usr/bin/env bash
# ── BeatForge — font bundler ─────────────────────────────────────────────────
#
# Downloads open-source font TTF files used by FFmpeg drawtext and libass into
# backend/assets/fonts/  so that renders are consistent across any machine,
# regardless of which fonts are installed system-wide.
#
# Fonts downloaded:
#   impact.ttf          — Impact (copied from macOS system fonts if available)
#   oswald-bold.ttf     — Oswald Bold 700  (SIL OFL — googlefonts/OswaldFont)
#   montserrat-bold.ttf — Montserrat Bold 700 (SIL OFL — JulietaUla/Montserrat)
#
# Usage:
#   cd backend && bash scripts/download-fonts.sh
#   — or —
#   npm run setup:fonts          (from backend/)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FONTS_DIR="$SCRIPT_DIR/../assets/fonts"
mkdir -p "$FONTS_DIR"

# Helper: download a file only if it doesn't already exist
download_if_missing() {
  local dest="$FONTS_DIR/$1"
  local url="$2"
  if [ -f "$dest" ]; then
    echo "  ✓ $1 already present — skipping"
    return
  fi
  echo "  ⬇  Downloading $1 …"
  if curl -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url"; then
    echo "  ✓ $1 saved"
  else
    echo "  ✗ Failed to download $1 from $url"
    rm -f "$dest"
    return 1
  fi
}

echo "BeatForge Font Bundler"
echo "Target: $FONTS_DIR"
echo ""

# ── Oswald Bold 700 ───────────────────────────────────────────────────────────
# Source: https://github.com/googlefonts/OswaldFont (SIL Open Font License 1.1)
download_if_missing "oswald-bold.ttf" \
  "https://github.com/googlefonts/OswaldFont/raw/main/fonts/ttf/Oswald-Bold.ttf"

# ── Montserrat Bold 700 ───────────────────────────────────────────────────────
# Source: https://github.com/JulietaUla/Montserrat (SIL Open Font License 1.1)
download_if_missing "montserrat-bold.ttf" \
  "https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Bold.ttf"

# ── Impact ────────────────────────────────────────────────────────────────────
# Impact is a system font included with macOS and Windows.
# Copy it from the local system so bundled renders look identical to previews.
if [ -f "$FONTS_DIR/impact.ttf" ]; then
  echo "  ✓ impact.ttf already present — skipping"
elif [ "$(uname)" = "Darwin" ] && [ -f "/Library/Fonts/Impact.ttf" ]; then
  cp "/Library/Fonts/Impact.ttf" "$FONTS_DIR/impact.ttf"
  echo "  ✓ impact.ttf copied from /Library/Fonts"
elif [ "$(uname)" = "Darwin" ] && [ -f "/System/Library/Fonts/Impact.ttf" ]; then
  cp "/System/Library/Fonts/Impact.ttf" "$FONTS_DIR/impact.ttf"
  echo "  ✓ impact.ttf copied from /System/Library/Fonts"
elif [ -f "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf" ]; then
  cp "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf" "$FONTS_DIR/impact.ttf"
  echo "  ✓ impact.ttf copied from system fonts"
else
  echo "  ⚠  impact.ttf not found on system — FFmpeg will use the system Impact font"
  echo "     (usually fine on macOS/Windows; on headless Linux install ttf-mscorefonts)"
fi

echo ""
echo "Done. Fonts bundled to: $FONTS_DIR"
echo ""
ls -lh "$FONTS_DIR" | grep -v "^total" || true
