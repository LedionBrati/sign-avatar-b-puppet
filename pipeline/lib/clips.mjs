// Shared clip logic for pipeline/sign-clips.mjs (cut + say), pipeline/speak.mjs and app/server/lib/ondemand.mjs.
// cutClips slices a repainted  NEUTRAL S1 NEUTRAL S2 ... NEUTRAL  batch into per-sign clips (all the same encoding);
// joinClips joins those clips with ffmpeg stream copy: no re-encode, no fal call.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

export const ffmpeg = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] });
export const toId = (gloss) => gloss.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Every clip gets the same encoding so joinClips can join them without re-encoding. */
export const CLIP_ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "24", "-g", "12", "-movflags", "+faststart"];
const execFileAsync = promisify(execFile);

export function loadManifest(clipsDir) {
  return JSON.parse(readFileSync(join(clipsDir, "manifest.json"), "utf8"));
}

/**
 * Cut points for a  NEUTRAL S1 NEUTRAL S2 ... NEUTRAL  batch: the middle of every neutral pause (segment gloss null),
 * so each sign clip starts and ends in the same still pose. Throws unless every sign is bracketed by neutrals.
 * @param {{gloss: string|null, start: number, end: number}[]} segments  compose.mjs / make-batches.mjs segments
 * @returns {{gloss: string, a: number, b: number}[]}  per sign: frames [a, b) of the batch video
 */
export function cutPoints(segments) {
  const mids = segments.filter((s) => !s.gloss).map((s) => Math.floor((s.start + s.end) / 2));
  const signs = segments.filter((s) => s.gloss);
  if (mids.length !== signs.length + 1) throw new Error("expected NEUTRAL around every sign");
  return signs.map((s, k) => ({ gloss: s.gloss, a: mids[k], b: mids[k + 1] }));
}

/**
 * Cut a repainted batch video into one clip per sign and merge them into OUT_DIR/manifest.json.
 * Clips and the manifest are written to a temp name and renamed, so a server reading the dir never sees half a file.
 * @param {object} o
 * @param {string} o.video     repainted batch, frame-exact with the motion the segments came from
 * @param {{gloss: string|null, start: number, end: number}[]} o.segments
 * @param {string} o.outDir
 * @param {{id: string, gloss: string}[]} [o.signs]  motion_id + manifest gloss per sign segment (default: toId(segment gloss))
 * @param {object} [o.extra]   extra fields for every new manifest entry
 * @param {(line: string) => void} [o.log]
 * @returns {Promise<{id, gloss, file, frames, seconds, source_frames}[]>}
 */
export async function cutClips({ video, segments, outDir, signs, extra = {}, log = () => {} }) {
  const cuts = cutPoints(segments);
  if (signs && signs.length !== cuts.length) throw new Error(`segments have ${cuts.length} signs, expected ${signs.length}`);
  mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const [k, c] of cuts.entries()) {
    const id = signs?.[k].id ?? toId(c.gloss), gloss = signs?.[k].gloss ?? c.gloss;
    const file = `${id}.mp4`, tmp = join(outDir, `${id}.part.mp4`);
    await execFileAsync("ffmpeg", ["-v", "error", "-y", "-i", video, "-vf", `trim=start_frame=${c.a}:end_frame=${c.b},setpts=PTS-STARTPTS`, ...CLIP_ENCODE, tmp],
      { maxBuffer: 4_000_000, windowsHide: true });
    renameSync(tmp, join(outDir, file));
    out.push({ id, gloss, file, frames: c.b - c.a, seconds: Number(((c.b - c.a) / 24).toFixed(3)), source_frames: [c.a, c.b] });
    log(`${id}: frames ${c.a}-${c.b} (${c.b - c.a})`);
  }
  const manifestPath = join(outDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  for (const c of out) {
    manifest[c.id] = { gloss: c.gloss, file: c.file, frames: c.frames, seconds: c.seconds, source_video: resolve(video), source_frames: c.source_frames, ...extra };
  }
  writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 1));
  renameSync(`${manifestPath}.tmp`, manifestPath);
  return out;
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
