#!/usr/bin/env node
/**
 * Buduje instalator .exe (Inno Setup) z folderu release/BeatForge-Windows.
 * Działa tylko na Windows. Wymaga: Inno Setup 6 (https://jrsoftware.org/isinfo.php).
 *
 * Uruchom najpierw: npm run build:win
 * Potem: npm run build:installer
 *
 * Wynik: release/BeatForge-Setup-1.0.exe
 */

const path = require("path");
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");

const root = path.resolve(__dirname, "..");
const releaseDir = path.join(root, "release", "BeatForge-Windows");
const issPath = path.join(root, "scripts", "installer", "BeatForge.iss");

if (process.platform !== "win32") {
  console.log("\n  Instalator .exe buduje się tylko na Windows.");
  console.log("  Zbuduj paczkę (npm run build:win), skopiuj na Windows i tam uruchom:");
  console.log("    npm run build:installer");
  console.log("  Lub zainstaluj Inno Setup i uruchom ręcznie:");
  console.log("    iscc scripts\\installer\\BeatForge.iss\n");
  process.exit(1);
}

if (!fs.existsSync(releaseDir)) {
  console.error("\n  Brak folderu release/BeatForge-Windows. Uruchom najpierw: npm run build:win\n");
  process.exit(1);
}

if (!fs.existsSync(issPath)) {
  console.error("\n  Brak pliku scripts/installer/BeatForge.iss\n");
  process.exit(1);
}

// Szukaj ISCC.exe (Inno Setup 6)
const isccCandidates = [
  "iscc",
  path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
  path.join(process.env.ProgramFiles || "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
];

let iscc = null;
for (const c of isccCandidates) {
  try {
    if (c === "iscc") {
      spawnSync("iscc", ["/?"], { stdio: "ignore" });
      iscc = "iscc";
    } else if (fs.existsSync(c)) {
      iscc = c;
    }
  } catch (_) {}
  if (iscc) break;
}

if (!iscc) {
  console.error("\n  Nie znaleziono Inno Setup 6 (ISCC.exe).");
  console.error("  Pobierz i zainstaluj: https://jrsoftware.org/isinfo.php\n");
  process.exit(1);
}

console.log("\n  Budowanie instalatora BeatForge (.exe)...\n");
const cmd = iscc === "iscc" ? `iscc "${issPath}"` : `"${iscc}" "${issPath}"`;
try {
  execSync(cmd, { cwd: root, stdio: "inherit" });
  console.log("\n  Gotowe. Instalator: release\\BeatForge-Setup-1.0.exe\n");
} catch (e) {
  process.exit(e.status || 1);
}
