// Shared clip-join logic for pipeline/sign-clips.mjs (say) and pipeline/speak.mjs.
// Joins pre-rendered per-sign clips (same encoding) with ffmpeg stream copy: no re-encode, no fal call.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export const ffmpeg = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] });
export const toId = (gloss) => gloss.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");

export function loadManifest(clipsDir) {
  return JSON.parse(readFileSync(join(clipsDir, "manifest.json"), "utf8"));
}

/**
 * Join clips for `ids` (in order) into `out`.
 * @returns {{ok: true, out, signs, video_seconds, assemble_ms} | {ok: false, unsupported: string[]}}
 */
export function joinClips({ clipsDir, ids, out, manifest = loadManifest(clipsDir) }) {
  const t0 = performance.now();
  const missing = ids.filter((id) => !manifest[id]);
  if (missing.length) return { ok: false, unsupported: missing };
  if (!ids.length) return { ok: false, unsupported: [], reason: "no clips to join" };
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "say-"));
  const list = join(dir, "list.txt");
  writeFileSync(list, ids.map((id) => `file '${resolve(clipsDir, manifest[id].file).replace(/\\/g, "/")}'`).join("\n"));
  try {
    ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const assemble_ms = Math.round(performance.now() - t0);
  const seconds = ids.reduce((sum, id) => sum + (manifest[id].seconds ?? 0), 0);
  return { ok: true, out, signs: ids, video_seconds: Number(seconds.toFixed(2)), assemble_ms };
}
