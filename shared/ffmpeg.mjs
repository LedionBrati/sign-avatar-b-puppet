// ffmpeg / ffprobe for the scripts that cut, encode, compare or count video frames. FFMPEG / FFPROBE (a path) win;
// otherwise the binary on PATH, then the bundled one from pipeline/ (ffmpeg-static, @ffprobe-installer/ffprobe; there
// after `npm install` in pipeline/). prefer: "bundled" checks the bundled one before PATH (e0 needs drawtext, which
// some system builds lack). One clear error when none runs. The result is cached per process.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const pipelineRequire = createRequire(new URL("../pipeline/package.json", import.meta.url));
const BUNDLED = {
  ffmpeg: () => pipelineRequire("ffmpeg-static"),
  ffprobe: () => pipelineRequire("@ffprobe-installer/ffprobe").path,
};
const ENV = { ffmpeg: "FFMPEG", ffprobe: "FFPROBE" };
const cache = new Map();

const runs = (bin) => {
  const r = spawnSync(bin, ["-version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
};

function bundled(name) {
  try { return BUNDLED[name]() || null; } catch { return null; }
}

/** Path (or command name) of ffmpeg / ffprobe. */
export function findTool(name, { env = process.env, prefer = "path", check = runs } = {}) {
  if (!ENV[name]) throw new Error(`unknown tool ${name}`);
  if (env[ENV[name]]) return env[ENV[name]];
  const key = `${name}:${prefer}`;
  if (check === runs && cache.has(key)) return cache.get(key);
  const order = prefer === "bundled" ? [bundled(name), name] : [name, bundled(name)];
  const hit = order.find((b) => b && check(b));
  if (!hit) {
    throw new Error(`${name} not found: put it on PATH (Windows: winget install Gyan.FFmpeg), set ${ENV[name]}=/path/to/${name}, ` +
      "or run npm install in pipeline/ for the bundled one");
  }
  if (check === runs) cache.set(key, hit);
  return hit;
}

export const ffmpegPath = (opts) => findTool("ffmpeg", opts);
export const ffprobePath = (opts) => findTool("ffprobe", opts);
