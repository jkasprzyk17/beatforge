#!/usr/bin/env node
/**
 * Buduje paczkę BeatForge pod Windows (jeden folder + .bat).
 * Uruchom na Windows, żeby node_modules backendu miały natywne moduły pod Win.
 * (Na Mac/Linux też zadziała, ale klient musi na Windows w folderze backend
 *  uruchomić „npm install” przed pierwszym startem.)
 *
 * Wynik: release/BeatForge-Windows/  (skopiuj do klienta; uruchom Start BeatForge.bat)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const releaseDir = path.join(root, "release", "BeatForge-Windows");
const backendDir = path.join(root, "backend");
const webDir = path.join(root, "web");

function run(cmd, opts = {}) {
  console.log("  " + cmd);
  execSync(cmd, { cwd: opts.cwd || root, stdio: "inherit", ...opts });
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest, filter = () => true) {
  if (!fs.existsSync(src)) return;
  mkdirp(dest);
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d, filter);
    else if (filter(s)) fs.copyFileSync(s, d);
  }
}

console.log("\n  Build BeatForge — paczka Windows\n");

// 1) Backend: kompilacja TS → dist
console.log("  [1/5] Backend: kompilacja TypeScript...");
run("npm run build:dist --prefix backend");

// 2) Web: build (bez VITE_API_URL = API względne, ten sam host)
console.log("  [2/5] Web: build Vite...");
run("npm run build --prefix web", {
  env: { ...process.env, VITE_API_URL: "" },
});

// 3) Katalog release
console.log("  [3/5] Tworzenie release/BeatForge-Windows...");
if (fs.existsSync(releaseDir)) fs.rmSync(releaseDir, { recursive: true });
mkdirp(releaseDir);

const pkgBackend = path.join(releaseDir, "backend");
mkdirp(pkgBackend);

// backend: dist, node_modules, assets/fonts, web-dist
copyDir(path.join(backendDir, "dist"), path.join(pkgBackend, "dist"));
copyDir(path.join(backendDir, "node_modules"), path.join(pkgBackend, "node_modules"));
if (fs.existsSync(path.join(backendDir, "assets")))
  copyDir(path.join(backendDir, "assets"), path.join(pkgBackend, "assets"));
copyDir(path.join(webDir, "dist"), path.join(pkgBackend, "web-dist"));

// 4) Start BeatForge.bat
const bat = `@echo off
title BeatForge
cd /d "%~dp0backend"
echo.
echo   BeatForge — uruchamiam serwer...
echo   Przegladarka otworzy sie za chwile. Nie zamykaj tego okna.
echo.
start /B cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:8000"
set NODE_ENV=production
node dist\\server.js
echo.
pause
`;
fs.writeFileSync(path.join(releaseDir, "Start BeatForge.bat"), bat, "utf8");

// 5) Krótka instrukcja
const readme = `BeatForge — uruchomienie na Windows
=====================================

1. Wymagania: Node.js 20 lub nowszy (https://nodejs.org) oraz FFmpeg w PATH.

2. Jeśli ten folder skopiowano z innego systemu (np. Mac), przed pierwszym
   startem otwórz w terminalu ten katalog i wpisz w folderze backend:
     cd backend
     npm install
   Potem wróć i uruchom "Start BeatForge.bat".

3. Uruchom: Start BeatForge.bat
   Otworzy się okno i po chwili przeglądarka z aplikacją.
   Nie zamykaj okna — to serwer. Zamknięcie = wyłączenie BeatForge.

4. (Opcja) Plik .exe zamiast .bat: żeby klient miał jeden "BeatForge.exe":
   - Użyj darmowego "Bat to Exe Converter" (np. f2ko.de) i wybierz "Start BeatForge.bat"
     → wygeneruje plik .exe uruchamiający to samo.
   - Lub stwórz instalator (np. Inno Setup), który rozpakuje folder i utworzy
     skrót do "Start BeatForge.bat" na pulpicie.
`;
fs.writeFileSync(path.join(releaseDir, "INSTRUKCJA.txt"), readme, "utf8");

console.log("  [4/5] Zapisano Start BeatForge.bat i INSTRUKCJA.txt");
console.log("  [5/5] Gotowe.\n");
console.log("  Paczka: " + releaseDir);
console.log("  Dla klienta: skopiuj cały folder BeatForge-Windows.");
if (process.platform === "win32") {
  console.log("  Instalator .exe: uruchom  npm run build:installer  → release/BeatForge-Setup-1.0.exe");
}
console.log("");
