// Build repaint batches for real-time sign clips from a gloss list.
//
// Each batch is  NEUTRAL S1 NEUTRAL S2 ... NEUTRAL  (one motion, same as puppet/compose.mjs),
// sized for H3 Max Recast (>= 5 s, no single shot > 15 s). For every batch it writes
//   OUT_DIR/PREFIX-N.clean.json   the motion, for puppet/render.mjs
//   OUT_DIR/PREFIX-N.json         compose.mjs-style summary with `segments`, for sign-clips.mjs cut
// and prints one JSON line per batch.
//
// Usage (Node 22+, from the repo root; it imports puppet/src/blend.ts directly):
//   node --experimental-strip-types --no-warnings pipeline/make-batches.mjs \
//     --motion-dir DIR --neutral out/realtime/neutral.clean.json --out-dir out/realtime/vocab \
//     [--prefix vocab] [--max-seconds 12] [--min-seconds 5] [--blend 0.2] [--min-pure 3] GLOSS ...
//
// --motion-dir   folder from motion/batch_library.py (uses its summary.csv to map gloss -> file;
//                falls back to GLOSS-*.clean.json). A gloss may also be given as GLOSS=path.clean.json.
// --max-seconds  target upper bound per batch (default 12; Recast's hard limit is 15)
// --min-seconds  Recast's minimum; a short last batch is padded by holding the final neutral
// --min-pure     fail if any neutral pause has fewer pure (unblended) neutral frames than this,
//                so the cut point in sign-clips.mjs always lands on a still pose
// Signs are kept in the given order and split into the fewest batches that fit, balanced in length.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { concatClips } = await import(pathToFileURL(resolve(import.meta.dirname, "../puppet/src/blend.ts")).href);

const argv = process.argv.slice(2);
const opt = { prefix: "vocab", "max-seconds": 12, "min-seconds": 5, blend: 0.2, "min-pure": 3, fps: 24 };
const glosses = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
  else glosses.push(argv[i]);
}
for (const k of ["max-seconds", "min-seconds", "blend", "min-pure", "fps"]) opt[k] = Number(opt[k]);
if (!opt["motion-dir"] && !glosses.every((g) => g.includes("="))) usage();
if (!opt.neutral || !opt["out-dir"] || glosses.length === 0) usage();
function usage() {
  console.error("usage: make-batches.mjs --motion-dir DIR --neutral N.clean.json --out-dir D [--prefix P] [--max-seconds 12] GLOSS ...");
  process.exit(2);
}

const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const norm = (g) => g.trim().toLowerCase().replace(/_/g, " ");

// gloss -> motion file
const byGloss = new Map();
const dir = opt["motion-dir"];
if (dir && existsSync(join(dir, "summary.csv"))) {
  const [head, ...lines] = readFileSync(join(dir, "summary.csv"), "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  for (const line of lines) {
    const row = Object.fromEntries(line.split(",").map((v, k) => [cols[k], v]));
    if (!row.error) byGloss.set(norm(row.gloss), join(dir, `${row.name}.clean.json`));
  }
}
const find = (g) => {
  if (g.includes("=")) return g.slice(g.indexOf("=") + 1);
  if (byGloss.has(norm(g))) return byGloss.get(norm(g));
  const stem = norm(g).replace(/ /g, "_");
  const f = dir && readdirSync(dir).find((x) => x.startsWith(stem + "-") && x.endsWith(".clean.json"));
  if (!f) throw new Error(`no motion for ${g}`);
  return join(dir, f);
};

const neutral = load(opt.neutral);
const signs = glosses.map((g) => ({ g: g.split("=")[0], path: find(g) })).map((s) => ({ ...s, motion: load(s.path) }));

const compose = (list, holdEnd = 0) => {
  const clips = [{ motion: neutral }];
  for (const s of list) clips.push({ motion: s.motion }, { motion: neutral });
  if (holdEnd > 0) clips[clips.length - 1].holdEnd = holdEnd;
  return concatClips(clips, { blend: opt.blend, fps: opt.fps });
};
const seconds = (m) => (m.frames.length - 1) / m.fps;

// Fewest batches under max-seconds, balanced: the smallest per-batch limit (from total / count
// upward) whose greedy split still needs only `count` batches.
const total = seconds(compose(signs).motion);
const split = (limit) => {
  const out = [];
  let cur = [];
  for (const s of signs) {
    const trial = [...cur, s];
    if (cur.length && seconds(compose(trial).motion) > limit) { out.push(cur); cur = [s]; } else cur = trial;
  }
  if (cur.length) out.push(cur);
  return out;
};
let batches;
for (let count = Math.max(1, Math.ceil(total / opt["max-seconds"])); ; count++) {
  for (let limit = total / count; limit <= opt["max-seconds"] + 1e-9 && !batches; limit += 0.1) {
    const b = split(Math.min(limit, opt["max-seconds"]));
    if (b.length <= count) batches = b;
  }
  if (batches) break;
  if (count >= signs.length) throw new Error(`a single sign is longer than --max-seconds ${opt["max-seconds"]}`);
}

mkdirSync(opt["out-dir"], { recursive: true });
batches.forEach((list, k) => {
  const name = `${opt.prefix}-${k + 1}`;
  let { motion, segments } = compose(list);
  const short = opt["min-seconds"] - seconds(motion);
  if (short > 0) ({ motion, segments } = compose(list, short + 1 / opt.fps));
  // pure neutral frames = neutral frames not touched by either neighbour's blend
  const pure = segments.map((s, i) => {
    if (s.gloss) return null;
    const a = i > 0 ? segments[i - 1].end + 1 : s.start;
    const b = i < segments.length - 1 ? segments[i + 1].start - 1 : s.end;
    return b - a + 1;
  }).filter((x) => x !== null);
  const inner = pure.slice(1, -1);
  if (inner.some((n) => n < opt["min-pure"])) throw new Error(`${name}: only ${Math.min(...inner)} pure neutral frames between signs (< ${opt["min-pure"]})`);
  motion.name = name;
  motion.source.parts = [neutral, ...list.flatMap((s) => [s.motion, neutral])].map((m) => ({
    name: m.name, motion_id: m.motion_id ?? null, gloss: m.gloss, file: m.source?.file ?? null, dataset: m.source?.dataset ?? null, signer: m.source?.signer ?? null,
  }));
  motion.cleanup.segments = segments;
  const out = join(opt["out-dir"], `${name}.clean.json`);
  writeFileSync(out, JSON.stringify(motion));
  const summary = {
    out, gloss: motion.gloss, frames: motion.frames.length, seconds: Number(seconds(motion).toFixed(3)),
    padded_s: short > 0 ? Number(short.toFixed(3)) : 0, min_pure_neutral_frames: Math.min(...inner, Infinity),
    segments: segments.map((s) => ({ gloss: s.gloss, start: s.start, end: s.end })),
  };
  writeFileSync(join(opt["out-dir"], `${name}.json`), JSON.stringify(summary));
  console.log(JSON.stringify({ batch: name, signs: list.map((s) => s.g), frames: summary.frames, seconds: summary.seconds, padded_s: summary.padded_s, min_pure_neutral_frames: summary.min_pure_neutral_frames }));
});
