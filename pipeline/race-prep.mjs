#!/usr/bin/env node
// Build a race reference from signs we already rendered: NEUTRAL S1 NEUTRAL S2 ... NEUTRAL, like a real batch.
//
//   node pipeline/race-prep.mjs --signs HELLO,WATER,THANK_YOU --out out/race/demo3 \
//        [--from out/realtime,out/realtime/vocab,out/realtime/phrases,out/mass/render] [--name demo3]
//
// For each sign it finds a puppet render `<base>-vrm.mp4` whose `<base>.json` has that gloss in its segments,
// cuts it at the neutral midpoints (the same cut as the clip factory), and joins the cuts. It writes:
//   <name>-vrm.mp4      the RGB reference (puppet today; swap in the realistic 3D render when it exists)
//   <name>.json         segments, so the finger metric scores sign frames only
//   <name>.clean.json   the motion slices joined, so the metric can also score against the source hands
//   <name>-pose.mp4     DWPose-style skeleton with hands, for pose-driven models (motion/render_pose.py)
// Free: ffmpeg + Python only.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLIP_ENCODE, cutPoints, ffmpeg, toId } from "./lib/clips.mjs";
import { motionPython, repoRoot } from "./lib/finger.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
if (!opt("signs") || !opt("out")) {
  console.error("usage: node pipeline/race-prep.mjs --signs HELLO,WATER,THANK_YOU --out DIR [--from dir1,dir2] [--name demo3]");
  process.exit(2);
}
const signs = opt("signs").split(",").map(toId);
const outDir = resolve(opt("out"));
const name = opt("name", "race");
const from = opt("from", "out/realtime,out/realtime/vocab,out/realtime/phrases,out/mass/render").split(",").map((d) => resolve(repoRoot, d));

/** First puppet render holding `id` among its sign segments. */
function findSign(id) {
  for (const dir of from) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith("-vrm.mp4")).sort()) {
      const base = f.replace(/-vrm\.mp4$/, "");
      const segFile = [join(dir, `${base}.json`), join(dir, "..", "batches", `${base}.json`)].find(existsSync);
      const motion = [join(dir, `${base}.clean.json`), join(dir, "..", "batches", `${base}.clean.json`)].find(existsSync);
      if (!segFile || !motion) continue;
      const segments = JSON.parse(readFileSync(segFile, "utf8")).segments;
      if (!Array.isArray(segments)) continue;
      let cuts;
      try { cuts = cutPoints(segments); } catch { continue; }
      const k = cuts.findIndex((c) => toId(c.gloss) === id);
      if (k === -1) continue;
      const sign = segments.filter((s) => s.gloss)[k];
      return { id, video: join(dir, f), motion, a: cuts[k].a, b: cuts[k].b, sign };
    }
  }
  throw new Error(`no rendered puppet batch holds ${id}; looked in ${from.join(", ")}`);
}

const parts = signs.map(findSign);
mkdirSync(outDir, { recursive: true });
const tmp = join(outDir, "parts");
mkdirSync(tmp, { recursive: true });

// 1. RGB: cut each sign at its neutral midpoints, then join (same encoding, so a concat demuxer join is exact).
const list = [];
for (const [k, p] of parts.entries()) {
  const file = join(tmp, `${k}-${p.id}.mp4`);
  ffmpeg(["-i", p.video, "-vf", `trim=start_frame=${p.a}:end_frame=${p.b},setpts=PTS-STARTPTS`, ...CLIP_ENCODE, file]);
  list.push(`file '${file.replace(/\\/g, "/")}'`);
}
writeFileSync(join(tmp, "list.txt"), list.join("\n"));
const video = join(outDir, `${name}-vrm.mp4`);
ffmpeg(["-f", "concat", "-safe", "0", "-i", join(tmp, "list.txt"), ...CLIP_ENCODE, video]);
rmSync(tmp, { recursive: true, force: true });

// 2. Segments in the joined timeline, neutral around every sign.
let offset = 0;
const signSegs = [];
for (const p of parts) {
  const len = p.b - p.a;
  signSegs.push({ gloss: p.sign.gloss, start: Math.max(offset, offset + p.sign.start - p.a), end: Math.min(offset + len - 1, offset + p.sign.end - p.a) });
  p.offset = offset;
  offset += len;
}
const frames = offset;
const segments = [];
let prev = 0;
for (const s of signSegs) { segments.push({ gloss: null, start: prev, end: s.start }, s); prev = s.end; }
segments.push({ gloss: null, start: prev, end: frames - 1 });

// 3. Motion: the same frame ranges of each batch's motion, renumbered.
const motions = parts.map((p) => JSON.parse(readFileSync(p.motion, "utf8")));
const first = motions[0];
const fps = first.fps ?? 24;
const joined = [];
for (const [k, p] of parts.entries()) {
  for (const f of motions[k].frames.slice(p.a, p.b)) {
    const i = joined.length;
    joined.push({ ...f, i, t: Number((i / fps).toFixed(4)) });
  }
}
const motion = { ...first, name, motion_id: null, gloss: signs.join(" "),
  source: { file: null, dataset: "race-prep", license: first.source?.license ?? null,
    parts: parts.map((p) => ({ sign: p.id, motion: p.motion, frames: [p.a, p.b] })) },
  cleanup: { ...(first.cleanup ?? {}), segments: undefined, race_prep: true }, frames: joined };
writeFileSync(join(outDir, `${name}.clean.json`), JSON.stringify(motion));
const meta = { out: join(outDir, `${name}.clean.json`), gloss: signs.join(" "), frames, seconds: Number((frames / 24).toFixed(3)), segments,
  parts: parts.map((p) => ({ sign: p.id, video: p.video, frames: [p.a, p.b], offset: p.offset })) };
writeFileSync(join(outDir, `${name}.json`), JSON.stringify(meta, null, 1) + "\n");

// 4. Pose conditioning video from the joined motion.
const [cmd, ...pre] = motionPython();
const pose = spawnSync(cmd, [...pre, join(repoRoot, "motion/render_pose.py"), join(outDir, `${name}.clean.json`), "--out", join(outDir, `${name}-pose.mp4`)],
  { encoding: "utf8", cwd: join(repoRoot, "motion") });
if (pose.status !== 0) throw new Error(`render_pose.py failed: ${pose.stderr}`);

console.log(JSON.stringify({ video, pose: join(outDir, `${name}-pose.mp4`), segments: join(outDir, `${name}.json`),
  motion: join(outDir, `${name}.clean.json`), frames, seconds: meta.seconds, parts: meta.parts }, null, 1));
