#!/usr/bin/env node
// One-time setup from a fresh clone: npm installs, the web build, the recognizer's Python env and models, the
// runtime assets (clips etc.) and a .env to fill in. Safe to re-run; finished steps are quick the second time.
//
//   npm run setup                    everything for the web app (both directions)
//   npm run setup -- --3d            also the 3D signer's motion library (large download)
//   npm run setup -- --ondemand      also what generating missing signs with fal needs (pipeline/ packages + --3d)
//   npm run setup -- --extension     also build the Chrome extension
//   npm run setup -- --no-assets     skip the asset download (mock / dev without clips)
//   npm run setup -- --no-recognizer skip Python (sign -> voice off)

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NODE_MIN, REPO, bold, fail, has, nodeOk, ok, run, step, warn } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
if (args.has("--ondemand")) args.add("--3d"); // signs are generated from the extracted motion in the 3D pack
const problems = [];

function npmInstall(dir) {
  const cwd = join(REPO, dir);
  // `npm ci` keeps the lockfile exact; fall back to install if node_modules is locked by a running dev server.
  if (!run("npm ci --no-audit --no-fund", { cwd }).ok && !run("npm install --no-audit --no-fund", { cwd }).ok) {
    throw new Error(`npm install failed in ${dir}`);
  }
  ok(dir);
}

step("Checking tools");
if (!nodeOk()) {
  fail(`Node ${process.versions.node}: Flux needs Node ${NODE_MIN.join(".")} or newer (Node 24 LTS recommended, https://nodejs.org).`);
  process.exit(1);
}
ok(`node ${process.versions.node}`);
const uv = has("uv");
if (uv) ok("uv");
else if (!args.has("--no-recognizer")) warn("uv not found: sign -> voice needs it (https://docs.astral.sh/uv/getting-started/installation/). Skipping the recognizer.");
if (has("ffmpeg")) ok("ffmpeg");
else warn("ffmpeg not found: only needed for the /api/sign.mp4 export and making new clips (https://ffmpeg.org/download.html).");
if (!has("tar")) problems.push("tar not found (it ships with Windows 10+, macOS and Linux); assets cannot be unpacked.");

try {
  step("Installing JavaScript packages");
  // puppet/ is needed by the web build too: the 3D signer player is imported from puppet/src.
  for (const dir of ["translate", "app/core", "app/server", "puppet", "app/web"]) npmInstall(dir);
  if (args.has("--extension")) npmInstall("app/extension");
  if (args.has("--ondemand")) npmInstall("pipeline");

  step("Building the web app (served by the API at /app/)");
  if (!run("npm run build", { cwd: join(REPO, "app/web") }).ok) throw new Error("web build failed");
  ok("app/web/dist");

  if (args.has("--extension")) {
    step("Building the Chrome extension");
    if (!run("npm run build", { cwd: join(REPO, "app/extension") }).ok) throw new Error("extension build failed");
    ok("app/extension/.output/chrome-mv3 (load it unpacked from chrome://extensions)");
  }

  if (uv && !args.has("--no-recognizer")) {
    step("Recognizer (Python): environment and pretrained models (about 52 MB)");
    const cwd = join(REPO, "app/recognizer");
    if (!run("uv sync", { cwd }).ok) throw new Error("uv sync failed in app/recognizer");
    if (!run("uv run python fetch_models.py", { cwd }).ok) throw new Error("fetching recognizer models failed");
    ok("app/recognizer/models");
  }

  if (!args.has("--no-assets")) {
    step("Runtime assets: sign clips, 3D signer, recognizer templates");
    const a = run(`node scripts/assets.mjs fetch${args.has("--3d") ? " --3d" : ""}`);
    if (!a.ok) problems.push("asset download failed: re-run `npm run assets` (the app still starts; signs show as captions only).");
  }
} catch (e) {
  fail(e.message);
  process.exit(1);
}

step("Config");
if (existsSync(join(REPO, ".env"))) ok(".env exists (left as is)");
else { copyFileSync(join(REPO, ".env.example"), join(REPO, ".env")); ok("created .env from .env.example"); }

for (const p of problems) warn(p);
console.log(`
${bold("Setup done.")} Next:
  1. Optional: put your OpenAI key in .env (OPENAI_API_KEY=...) for speech transcription, spoken sentences and voice.
  2. npm start        then open http://localhost:8787/app/
`);
