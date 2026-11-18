#!/usr/bin/env node
// One command for the local app: the sign -> voice recognizer (Python, :8788) and the API (Node, :8787, serves the
// built web app at /app/). Settings come from the environment, then from .env in the repo root.
//
//   npm start                 (= node app/start.mjs)
//   npm run dev               also the Vite dev server for the web app with live reload (:5173)
//
//   NO_RECOGNIZER=1 skips the Python service; PORT / RECOGNIZER_PORT / HOST as in .env.example.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(fileURLToPath(import.meta.url));
const repo = dirname(app);
const WIN = process.platform === "win32";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Flux needs Node 22.18 or newer (you have ${process.versions.node}). Node 24 LTS: https://nodejs.org`);
  process.exit(1);
}
// Variables already set in the environment win over .env.
if (existsSync(join(repo, ".env"))) process.loadEnvFile(join(repo, ".env"));

const recPort = process.env.RECOGNIZER_PORT ?? "8788";
const kids = [];

/** cmd + args run directly (no shell), or a whole command line through the shell (needed for npm.cmd). */
function start(name, cmd, args, opts = {}) {
  const p = args ? spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts }) : spawn(cmd, { stdio: ["ignore", "pipe", "pipe"], shell: true, ...opts });
  const tag = (s) => s.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("error", (e) => console.log(`[${name}] could not start: ${e.message}`));
  p.on("exit", (code) => {
    console.log(`[${name}] exited (${code})`);
    if (name === "api") stop(code ?? 0);
    if (name === "recognizer") console.log("[recognizer] sign -> voice is off; the rest of the app keeps running.");
  });
  kids.push(p);
  return p;
}

function stop(code = 0) {
  for (const k of kids) {
    if (k.exitCode !== null || !k.pid) continue;
    // Kill the whole tree on Windows (uv -> python, cmd -> npm -> vite).
    if (WIN) spawnSync("taskkill", ["/pid", String(k.pid), "/T", "/F"], { stdio: "ignore" });
    else k.kill();
  }
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const hasUv = spawnSync(WIN ? "where" : "which", ["uv"], { stdio: "ignore" }).status === 0;
if (process.env.NO_RECOGNIZER === "1") {
  console.log("[recognizer] skipped (NO_RECOGNIZER=1)");
} else if (!hasUv) {
  console.log("[recognizer] uv not found, sign -> voice is off (install uv, then npm run setup)");
} else if (!existsSync(join(app, "recognizer", "models", "gislr.tflite"))) {
  console.log("[recognizer] models missing, sign -> voice is off (run npm run setup)");
} else {
  start("recognizer", "uv", ["run", "python", "server.py"], { cwd: join(app, "recognizer"), env: { ...process.env, RECOGNIZER_PORT: recPort } });
}

if (!existsSync(join(app, "web", "dist", "index.html")) && !process.argv.includes("--web-dev")) {
  console.log("[api] app/web/dist is missing, /app/ will 404: run npm run setup (or npm run dev for the dev server)");
}
start("api", process.execPath, [join(app, "server", "index.mjs")], {
  env: { ...process.env, RECOGNIZER_URL: process.env.RECOGNIZER_URL ?? `http://127.0.0.1:${recPort}` },
});

if (process.argv.includes("--web-dev")) start("web", "npm run dev", null, { cwd: join(app, "web") });
