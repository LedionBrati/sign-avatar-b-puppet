// Finger fidelity helpers: find reference/generated pairs and run motion/finger_fidelity.py on them.
// The Python side does the tracking and the maths; this side only finds files and starts it.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Python with mediapipe: $MOTION_PYTHON, else motion/.venv, else `uv run` in motion/. */
export function motionPython() {
  if (process.env.MOTION_PYTHON) return [process.env.MOTION_PYTHON];
  for (const p of ["motion/.venv/Scripts/python.exe", "motion/.venv/bin/python"]) {
    if (existsSync(join(repoRoot, p))) return [join(repoRoot, p)];
  }
  return ["uv", "run", "--project", join(repoRoot, "motion"), "python"];
}

/** Segment file (`{segments: [...]}`) and motion file for a puppet video named `<base>-vrm.mp4`. */
export function sidecars(refVideo) {
  const dir = dirname(refVideo);
  const base = basename(refVideo).replace(/\.mp4$/i, "").replace(/-vrm$/, "");
  const dirs = [dir, join(dir, "..", "batches"), join(dir, "..", "phrases")];
  const find = (name, test) => dirs.map((d) => join(d, name)).find((p) => existsSync(p) && (!test || test(p))) ?? null;
  const hasSegments = (p) => { try { return Array.isArray(JSON.parse(readFileSync(p, "utf8")).segments); } catch { return false; } };
  return { segments: find(`${base}.json`, hasSegments), motion: find(`${base}.clean.json`) };
}

/** Every run folder under `roots` holding result.json + generated.mp4 whose puppet still exists. */
export function findPairs(roots, group = (root) => basename(root)) {
  const pairs = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort()) {
      const runDir = join(root, name);
      const result = join(runDir, "result.json"), gen = join(runDir, "generated.mp4");
      if (!existsSync(result) || !existsSync(gen)) continue;
      const ref = JSON.parse(readFileSync(result, "utf8")).inputs?.puppet?.path;
      if (!ref || !existsSync(ref)) continue;
      pairs.push({ name, group: group(root), ref, gen, ...sidecars(ref) });
    }
  }
  return pairs;
}

function runPython(args, { quiet = false } = {}) {
  const [cmd, ...pre] = motionPython();
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, [...pre, join(repoRoot, "motion/finger_fidelity.py"), ...args],
      { cwd: join(repoRoot, "motion"), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (!quiet) process.stdout.write(d); });
    // MediaPipe is chatty on stderr; keep only real errors.
    child.stderr.on("data", (d) => { const s = String(d); if (/Error|Traceback|error:/.test(s)) process.stderr.write(s); });
    child.on("close", (code) => code === 0 ? resolveRun(out) : reject(new Error(`finger_fidelity.py exited ${code}`)));
  });
}

/** Score one pair. Returns the parsed one-line headline. */
export async function scorePair({ ref, gen, out, name, segments, motion, recognizer, maxShift = 0 }) {
  const args = ["pair", "--ref", ref, "--gen", gen, "--out", out, "--max-shift", String(maxShift)];
  if (name) args.push("--name", name);
  if (segments) args.push("--segments", segments);
  if (motion) args.push("--motion", motion);
  if (recognizer) args.push("--recognizer", recognizer);
  const text = await runPython(args, { quiet: true });
  return JSON.parse(text.trim().split("\n").pop());
}

/** Score many pairs (tracking runs in parallel processes). Writes <out>/pairs.json and <out>/summary.json. */
export async function scoreBatch(pairs, out, { workers, recognizer } = {}) {
  mkdirSync(out, { recursive: true });
  const file = join(out, "pairs.json");
  writeFileSync(file, JSON.stringify(pairs, null, 1) + "\n");
  const args = ["batch", "--pairs", file, "--out", out];
  if (workers) args.push("--workers", String(workers));
  if (recognizer) args.push("--recognizer", recognizer);
  await runPython(args);
  return JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
}
