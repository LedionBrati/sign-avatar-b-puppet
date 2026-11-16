#!/usr/bin/env node
// Finger fidelity: how well does a generated video keep the fingers of its reference (puppet) video?
//
// One pair:
//   node pipeline/finger-fidelity.mjs --ref PUPPET.mp4 --gen GENERATED.mp4 --out DIR \
//        [--segments PHRASE.json] [--motion PHRASE.clean.json] [--recognizer http://127.0.0.1:8788]
//   (--segments and --motion are found next to a `<name>-vrm.mp4` puppet when not given)
//
// Baseline over every existing Recast run (result.json + generated.mp4 per run folder):
//   node pipeline/finger-fidelity.mjs --baseline --out out/finger/baseline \
//        [--roots out/realtime/runs,experiments/e0/runs,out/archive/e0-runs-sbp-mass/mass] [--workers 8]
//
// Free: MediaPipe on the CPU, no fal calls. Details and numbers: experiments/2026-11-16-finger-fidelity.md.

import { resolve } from "node:path";
import { findPairs, repoRoot, scoreBatch, scorePair, sidecars } from "./lib/finger.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const recognizer = opt("recognizer", "http://127.0.0.1:8788");

if (argv.includes("--help") || argv.length === 0) {
  console.log("usage: --ref REF.mp4 --gen GEN.mp4 --out DIR [--segments S.json] [--motion M.clean.json]\n" +
    "   or: --baseline --out DIR [--roots a,b,c] [--workers N]   (see the header of this file)");
  process.exit(argv.length === 0 ? 2 : 0);
}

const out = resolve(opt("out", resolve(repoRoot, "out/finger")));
if (argv.includes("--baseline")) {
  const roots = opt("roots", "out/realtime/runs,experiments/e0/runs,out/archive/e0-runs-sbp-mass/mass")
    .split(",").map((r) => resolve(repoRoot, r));
  const pairs = findPairs(roots, (root) => (root.includes("mass") ? "mass" : root.includes("e0") ? "e0" : "realtime"));
  console.log(`${pairs.length} pairs (${pairs.filter((p) => p.segments).length} with sign segments, ${pairs.filter((p) => p.motion).length} with motion)`);
  const summary = await scoreBatch(pairs, out, { workers: opt("workers"), recognizer });
  console.log(`summary: ${resolve(out, "summary.json")}`);
  console.table(Object.fromEntries(Object.entries(summary.groups).map(([g, s]) => [g, {
    pairs: s.pairs, hand_frames: s.hand_frames_scored, joint_err: s.mean_joint_err_deg, shape_change: s.handshape_change_pct,
    drop: s.drop_pct, motion_gen_err: s.motion_vs_gen_joint_err_deg, motion_gen_shape: s.motion_vs_gen_shape_change_pct }])));
} else {
  const ref = resolve(opt("ref")), gen = resolve(opt("gen"));
  const found = sidecars(ref);
  const row = await scorePair({ ref, gen, out, name: opt("name"), recognizer,
    segments: opt("segments", found.segments), motion: opt("motion", found.motion) });
  console.log(JSON.stringify(row, null, 1));
}
