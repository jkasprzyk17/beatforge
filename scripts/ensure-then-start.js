#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(path.join(__dirname, ".."));
const needSetup =
  !fs.existsSync(path.join(root, "backend", "node_modules")) ||
  !fs.existsSync(path.join(root, "web", "node_modules"));

if (needSetup) {
  console.log("\n  Pierwsze uruchomienie — instaluję wszystko (może chwilę potrwać)...\n");
  execSync("npm run setup", { cwd: root, stdio: "inherit" });
  console.log("\n  Gotowe. Uruchamiam aplikację...\n");
}

execSync("npx concurrently -n api,web \"npm run dev --prefix backend\" \"npm run dev --prefix web\"", {
  cwd: root,
  stdio: "inherit",
});
