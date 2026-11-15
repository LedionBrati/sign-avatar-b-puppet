#!/usr/bin/env node
// One command for the local demo: the sign -> voice recognizer (Python, :8788) and the API (Node, :8787, serves /app/).
//
//   node app/start.mjs            NO_RECOGNIZER=1 to skip the Python service; PORT / RECOGNIZER_PORT as usual
//
// The web app is served from app/web/dist at /app/ (build it once: cd app/web && npm i && npm run build),
// or run the Vite dev server separately (cd app/web && npm run dev).

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(fileURLToPath(import.meta.url));
const recPort = process.env.RECOGNIZER_PORT ?? "8788";
const kids = [];

function run(name, cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...opts });
  const tag = (s) => s.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("exit", (code) => { console.log(`[${name}] exited (${code})`); if (name === "api") stop(code ?? 0); });
  kids.push(p);
  return p;
}

function stop(code = 0) {
  for (const k of kids) {
    if (k.exitCode !== null) continue;
    // shell: true on Windows, so kill the whole tree (cmd -> uv -> python).
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(k.pid), "/T", "/F"], { stdio: "ignore" });
    else k.kill();
  }
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

if (process.env.NO_RECOGNIZER !== "1") {
  const rec = join(app, "recognizer");
  if (!existsSync(join(rec, "models", "gislr.tflite"))) {
    console.log("[recognizer] models missing: run  cd app/recognizer && uv run python fetch_models.py");
  } else {
    run("recognizer", "uv", ["run", "python", "server.py"], { cwd: rec, env: { ...process.env, RECOGNIZER_PORT: recPort } });
  }
}
run("api", "node", [join(app, "server", "index.mjs")], {
  env: { ...process.env, RECOGNIZER_URL: process.env.RECOGNIZER_URL ?? `http://127.0.0.1:${recPort}` },
});
