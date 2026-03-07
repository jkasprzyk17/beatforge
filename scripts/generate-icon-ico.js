#!/usr/bin/env node
/**
 * Generuje web/public/icon.ico z web/public/icon.png (dla instalatora Windows).
 * Uruchom: node scripts/generate-icon-ico.js
 */
const path = require("path");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const pngPath = path.join(root, "web", "public", "icon.png");
const icoPath = path.join(root, "web", "public", "icon.ico");

if (!fs.existsSync(pngPath)) {
  console.error("Brak pliku web/public/icon.png. Dodaj ikonę aplikacji w tym miejscu.");
  process.exit(1);
}

async function run() {
  const { default: pngToIco } = await import("png-to-ico");
  const buf = await pngToIco(pngPath);
  fs.writeFileSync(icoPath, buf);
  console.log("Zapisano web/public/icon.ico");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
