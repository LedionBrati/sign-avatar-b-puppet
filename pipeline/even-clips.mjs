// Make every sign clip look like it came from ONE camera: same wall colour, same head size and place.
//
// Clips repainted in different H3 Max Recast jobs don't match (each job picks its own wall tone and
// zoom), so a sentence that joins them jumps. This reads a clip folder (manifest.json + mp4s), measures
// each Recast job, and writes an evened copy to a new folder. The originals are never touched.
// Free: ffmpeg only. About half a second per clip.
//
//   node pipeline/even-clips.mjs --clips out/realtime/clips --out out/realtime/clips-even
//   CLIPS_DIR=out/realtime/clips-even node app/server/index.mjs
//
// Clips cut from the same Recast video (same `source_video` in the manifest, written by
// `sign-clips.mjs cut`) already match each other, so they are measured together and get ONE
// correction. A clip without `source_video` is treated as its own job.
//
// With Nikos's pipeline/normalize-backgrounds.py (wall colour only, via a person matte): run that
// first, then this on its output with --color 0, so this only fixes the head size and place.
//
// Options:
//   --color 0       zoom and shift only, leave the colours alone (default 1: also match wall + skin)
//   --ref ID        use the job of this clip as the look to match (default: the most typical job)
//   --target FILE   use a saved target (default: <out>/even-target.json if it exists, so the look
//                   stays the same when you add new batches and run this again)
//   --size WxH      output size (default: the target's size, e.g. 768x1024)
//   --dry 1         measure and plan only, write nothing
//
// After a new batch: `sign-clips.mjs cut` into the raw folder as before, then run this again with the
// same --out. It re-evens every clip against the saved target, so old and new clips match.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLIP_ENCODE, ffmpeg } from "./lib/clips.mjs";
import { evenFilter, measureClips, pickTarget } from "./lib/even.mjs";

const opt = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
if (!opt.clips || !opt.out) {
  console.error("usage: even-clips.mjs --clips DIR --out DIR [--color 0] [--ref ID] [--target FILE] [--size WxH] [--dry 1]");
  process.exit(2);
}
const clipsDir = resolve(opt.clips), outDir = resolve(opt.out);
if (clipsDir === outDir) throw new Error("--out must be a different folder: the originals are kept as they are");
const manifest = JSON.parse(readFileSync(join(clipsDir, "manifest.json"), "utf8"));
const dry = Boolean(opt.dry && opt.dry !== "0");
const color = opt.color !== "0";
const clipPath = (dir, e) => resolve(dir, e.file);

// 1. Group clips by the Recast job they were cut from, and measure each job.
const groups = new Map(), failed = [];
for (const [id, e] of Object.entries(manifest)) {
  if (!e || typeof e.file !== "string" || !existsSync(clipPath(clipsDir, e))) { failed.push([id, "missing file"]); continue; }
  const key = e.source_video ? `job:${e.source_video}` : `clip:${id}`;
  if (!groups.has(key)) groups.set(key, { key, ids: [] });
  groups.get(key).ids.push(id);
}
const measured = [];
for (const g of groups.values()) {
  try { g.m = measureClips(g.ids.map((id) => clipPath(clipsDir, manifest[id]))); measured.push(g); }
  catch (error) { for (const id of g.ids) failed.push([id, error.message]); }
}
if (!measured.length) throw new Error("no clip could be measured");
console.log(`${Object.keys(manifest).length} clips from ${groups.size} Recast job(s)`);

// 2. The target look: a saved one, a chosen clip's job, or the most typical job.
const savedTarget = opt.target ?? (existsSync(join(outDir, "even-target.json")) ? join(outDir, "even-target.json") : null);
let target;
if (savedTarget) target = JSON.parse(readFileSync(savedTarget, "utf8"));
else if (opt.ref) {
  const g = measured.find((x) => x.ids.includes(opt.ref));
  if (!g) throw new Error(`--ref ${opt.ref} is not in the manifest (or could not be measured)`);
  target = { from: opt.ref, ...g.m };
} else {
  const t = pickTarget(measured.map((g) => [g.ids[0], g.m]));
  target = { ...t, from: `job of ${t.from}` };
}
if (opt.size) [target.w, target.h] = opt.size.split("x").map(Number);
console.log(`target look: ${target.from ?? "saved"}  wall ${target.wall}  face width ${target.size}  hairline ${target.top}  size ${target.w}x${target.h}`);

// 3. Even every clip with its job's correction, then measure each job again (the proof that it worked).
if (!dry) mkdirSync(outDir, { recursive: true });
const report = { target, jobs: [], failed: Object.fromEntries(failed) };
const out = {};
for (const g of measured) {
  const plan = evenFilter(g.m, target, { color });
  // A job whose face could not really be measured gives a NaN zoom/shift: copy it unchanged (below) instead of failing.
  if (/NaN|Infinity/.test(plan.filter)) {
    for (const id of g.ids) { failed.push([id, "face not measurable (zoom/shift would be NaN)"]); report.failed[id] = failed.at(-1)[1]; }
    continue;
  }
  const row ={ job: g.key, clips: g.ids, before: g.m, scale: plan.scale, shift_px: plan.shift_px, gain: plan.gain, offset: plan.offset, extra_zoom_pct: plan.extra_zoom_pct };
  for (const id of g.ids) {
    const e = manifest[id];
    if (!dry) ffmpeg(["-i", clipPath(clipsDir, e), "-vf", plan.filter, ...CLIP_ENCODE, join(outDir, e.file)]);
    out[id] = { ...e, even: { job: g.key, scale: plan.scale, shift_px: plan.shift_px, gain: plan.gain, offset: plan.offset } };
  }
  if (!dry) {
    const a = measureClips(g.ids.map((id) => join(outDir, manifest[id].file)));
    row.after = a;
    row.left_over = {
      wall: Math.max(...a.wall.map((v, c) => Math.abs(v - target.wall[c]))),   // colour levels (0-255)
      face_size_pct: Number(((a.size / target.size - 1) * 100).toFixed(1)),
      hairline_px: Math.round((a.top - target.top) * target.h),
      centre_px: Math.round((a.cx - target.cx) * target.w),
    };
  }
  report.jobs.push(row);
  const lo = row.left_over;
  const name = g.ids.length > 3 ? `${g.ids.slice(0, 3).join(" ")} +${g.ids.length - 3}` : g.ids.join(" ");
  console.log(`${name.padEnd(28)} zoom ${plan.scale.toFixed(3)}${plan.extra_zoom_pct ? ` (+${plan.extra_zoom_pct}% to cover the frame)` : ""}  shift ${plan.shift_px.join(",").padEnd(8)} ${color ? `wall ${g.m.wall} -> ${target.wall}` : "colour left as is"}` +
    (lo ? `   left over: wall ${lo.wall}, face ${lo.face_size_pct}%, hairline ${lo.hairline_px}px, centre ${lo.centre_px}px` : ""));
}
// Clips we could not measure are copied as they are and listed, never dropped silently.
for (const [id, why] of failed) {
  console.warn(`WARNING ${id}: ${why}. ${dry ? "Would copy" : "Copied"} unchanged.`);
  const e = manifest[id];
  if (!dry && e && typeof e.file === "string" && existsSync(clipPath(clipsDir, e))) { copyFileSync(clipPath(clipsDir, e), join(outDir, e.file)); out[id] = e; }
}

if (!dry) {
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(out, null, 1));
  if (!existsSync(join(outDir, "even-target.json"))) writeFileSync(join(outDir, "even-target.json"), JSON.stringify(target, null, 1));
  writeFileSync(join(outDir, "even-report.json"), JSON.stringify(report, null, 1));
  console.log(`wrote ${Object.keys(out).length} clips + manifest.json + even-target.json + even-report.json to ${outDir}`);
}
