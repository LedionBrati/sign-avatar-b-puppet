// Join several sign motion files into one sentence motion (motion/FORMAT.md v1).
//
// Usage (Node 22+, runs blend.ts directly):
//   node --experimental-strip-types puppet/compose.mjs --out out/puppet/sentence.clean.json \
//        [--blend 0.2] [--fps 24] [--min-seconds 5] a.clean.json b.clean.json c.clean.json
//
// --blend        cross-blend between neighbouring signs, seconds (default 0.2)
// --fps          output frame rate (default 24, the avatar's)
// --min-seconds  hold the last frame until the sentence is at least this long
//                (H3 Max Recast needs >= 5 s; default 0 = no padding)
//
// Prints one JSON line: frames, seconds, per-sign segments, timing.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { concatClips } from "./src/blend.ts";

const argv = process.argv.slice(2);
const opts = { blend: 0.2, fps: 24, "min-seconds": 0 };
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${a}`);
    opts[a.slice(2)] = a === "--out" ? v : Number(v);
  } else inputs.push(a);
}
if (!opts.out || inputs.length === 0) {
  console.error("usage: compose.mjs --out OUT.clean.json [--blend 0.2] [--fps 24] [--min-seconds 5] A.json B.json ...");
  process.exit(2);
}

const t0 = performance.now();
const motions = await Promise.all(inputs.map(async (p) => JSON.parse(await readFile(p, "utf8"))));
const tLoad = performance.now();

const clips = motions.map((motion) => ({ motion }));
let { motion, segments } = concatClips(clips, { blend: opts.blend, fps: opts.fps });
const seconds = (m) => (m.frames.length - 1) / m.fps;
const short = opts["min-seconds"] - seconds(motion);
if (short > 0) {
  // Re-run with a hold on the last sign so the padding is a still pose, not a jump.
  clips[clips.length - 1].holdEnd = short + 1 / opts.fps;
  ({ motion, segments } = concatClips(clips, { blend: opts.blend, fps: opts.fps }));
}
const stem = basename(opts.out).replace(/\.(clean|raw)\.json$/, "").replace(/\.json$/, "");
motion.name = stem; // the shared loader checks name == file stem
motion.source.parts = motions.map((m) => ({ name: m.name, motion_id: m.motion_id ?? null, gloss: m.gloss, file: m.source?.file ?? null, dataset: m.source?.dataset ?? null, signer: m.source?.signer ?? null }));
motion.cleanup.segments = segments;
const tBlend = performance.now();

await mkdir(dirname(resolve(opts.out)), { recursive: true });
await writeFile(opts.out, JSON.stringify(motion));
const tWrite = performance.now();

console.log(JSON.stringify({
  out: opts.out,
  gloss: motion.gloss,
  frames: motion.frames.length,
  seconds: Number(seconds(motion).toFixed(3)),
  padded_s: short > 0 ? Number(short.toFixed(3)) : 0,
  segments: segments.map((s) => ({ gloss: s.gloss, start: s.start, end: s.end })),
  ms: { load: Math.round(tLoad - t0), blend: Math.round(tBlend - tLoad), write: Math.round(tWrite - tBlend), total: Math.round(tWrite - t0) },
}));
