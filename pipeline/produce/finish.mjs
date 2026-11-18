#!/usr/bin/env node
// Cut + even + write a clip folder for pipeline/produce.mjs. Runs on Modal (pipeline/produce/modal_post.py) because
// cutting and re-encoding hundreds of 1080P clips would cook the laptop; the unit test runs it on a tiny video.
//
//   node pipeline/produce/finish.mjs --spec SPEC.json
//
// Incremental: `final` is a persistent folder (on the Modal volume). Only repaint jobs (source videos) with a new
// or changed clip are cut and evened again; a job is always processed whole, because even-clips.mjs measures a job
// over all its clips and gives it ONE correction (so joins inside a job stay seamless).
//
// SPEC: {
//   final: "/vol/produce/demo/final",      the clip folder (manifest.json + <ID>.mp4 + sentences/ + even-*.json)
//   raw, inc: scratch folders               cuts before evening / this increment after evening
//   target: "/vol/produce/even-target-1080P.json" | null   shared look (every set matches); created if missing
//   color: true,                           even-clips.mjs --color
//   clips: [{id, gloss, video, source_video, a, b, every, extra, aliases: [{id, gloss}]}],   ALL clips of the set
//   sentences: [{id, video, source_video, every, frames, meta}] }
// a, b: frames [a, b) of the video after keeping every `every`-th frame (lib.mjs cutPoints).
// source_video is the repaint job's label (one per take); it groups clips for even-clips.mjs.
// Returns {changed: [relative paths written this time], clips, aliases, sentences, jobs_processed}.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath } from "../../shared/ffmpeg.mjs";
import { CLIP_ENCODE } from "../lib/clips.mjs";
import { evenFilter } from "../lib/even.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ffmpeg = (args) => execFileSync(ffmpegPath(), ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] });
const thin = (every) => (every > 1 ? `select='not(mod(n\\,${every}))',setpts=N/24/TB,` : "");
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => { writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 1)); renameSync(`${p}.tmp`, p); };
export const cutKey = (c) => `${c.source_video}|${c.a}|${c.b}|${c.every}`;

export function finish(spec, { log = (s) => console.log(s) } = {}) {
  const { final, raw, inc } = spec;
  mkdirSync(final, { recursive: true });
  const old = readJson(join(final, "manifest.json"), {});
  const oldSentences = readJson(join(final, "sentences.json"), []);

  // 1. Which jobs need work: any clip new or cut differently, or a sentence not made yet.
  const jobs = new Map();
  for (const c of spec.clips) { if (!jobs.has(c.source_video)) jobs.set(c.source_video, []); jobs.get(c.source_video).push(c); }
  const sentenceDone = (s) => oldSentences.some((o) => o.id === s.id && o.source_video === s.source_video && existsSync(join(final, o.file)));
  const changed = new Set();
  for (const [job, cs] of jobs) {
    if (spec.force || cs.some((c) => old[c.id]?.cut_key !== cutKey(c) || !existsSync(join(final, old[c.id].file)))) changed.add(job);
  }
  for (const s of spec.sentences ?? []) if (!sentenceDone(s) && jobs.has(s.source_video)) changed.add(s.source_video);
  const todo = spec.clips.filter((c) => changed.has(c.source_video));
  log(`${jobs.size} job(s), ${changed.size} new or changed: cutting ${todo.length} clip(s)`);

  // 2. Cut the clips of those jobs.
  rmSync(raw, { recursive: true, force: true });
  rmSync(inc, { recursive: true, force: true });
  mkdirSync(raw, { recursive: true });
  const cutManifest = {};
  for (const c of todo) {
    const file = `${c.id}.mp4`, tmp = join(raw, `${c.id}.part.mp4`);
    ffmpeg(["-i", c.video, "-vf", `${thin(c.every)}trim=start_frame=${c.a}:end_frame=${c.b},setpts=PTS-STARTPTS`, ...CLIP_ENCODE, tmp]);
    renameSync(tmp, join(raw, file));
    cutManifest[c.id] = { gloss: c.gloss, file, frames: c.b - c.a, seconds: Number(((c.b - c.a) / 24).toFixed(3)), source_video: c.source_video,
      source_frames: [c.a * c.every, c.b * c.every], ...(c.every > 1 ? { every: c.every } : {}), ...(c.extra ?? {}), cut_key: cutKey(c) };
  }
  writeJson(join(raw, "manifest.json"), cutManifest);

  // 3. Even wall colour and zoom per job against the shared target (pipeline/even-clips.mjs).
  const written = [];
  let report = null;
  if (todo.length) {
    const target = spec.target && existsSync(spec.target) ? spec.target : null;
    const args = [join(HERE, "../even-clips.mjs"), "--clips", raw, "--out", inc, "--color", spec.color === false ? "0" : "1"];
    if (target) args.push("--target", target);
    try {
      execFileSync(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
    } catch (e) {
      // even-clips.mjs stops when no clip could be measured at all: keep the cuts as they are, and say so.
      log(`WARNING: even-clips failed (${String(e.message).split("\n")[0]}); clips kept unevened`);
      mkdirSync(inc, { recursive: true });
      for (const e2 of Object.values(cutManifest)) copyFileSync(join(raw, e2.file), join(inc, e2.file));
      writeJson(join(inc, "manifest.json"), cutManifest);
    }
    if (spec.target && !target && existsSync(join(inc, "even-target.json"))) {
      mkdirSync(dirname(spec.target), { recursive: true });
      copyFileSync(join(inc, "even-target.json"), spec.target);
      log(`saved the shared target look: ${spec.target}`);
    }
    for (const e of Object.values(readJson(join(inc, "manifest.json"), {}))) { copyFileSync(join(inc, e.file), join(final, e.file)); written.push(e.file); }
    report = readJson(join(inc, "even-report.json"), null);
    if (report) { mkdirSync(join(final, "even-reports"), { recursive: true }); const f = `even-reports/${new Date().toISOString().replace(/[:.]/g, "-")}.json`; writeJson(join(final, f), report); written.push(f); }
    if (existsSync(join(inc, "even-target.json")) && !existsSync(join(final, "even-target.json"))) { copyFileSync(join(inc, "even-target.json"), join(final, "even-target.json")); written.push("even-target.json"); }
  }

  // 4. The manifest: every clip of the spec (new entries from this increment, the rest kept), aliases, nothing stale.
  const evened = readJson(join(inc, "manifest.json"), {});
  const manifest = {};
  for (const c of spec.clips) {
    const e = changed.has(c.source_video) ? evened[c.id] && { ...evened[c.id], cut_key: cutKey(c) } : old[c.id];
    if (e) manifest[c.id] = e;
  }
  let aliases = 0;
  for (const c of spec.clips) {
    for (const a of c.aliases ?? []) {
      if (manifest[a.id] || !manifest[c.id]) continue;
      manifest[a.id] = { ...manifest[c.id], gloss: a.gloss, alias_of: c.id };
      aliases++;
    }
  }

  // 5. Whole sentence videos at normal speed, with their job's evening correction.
  const sentences = oldSentences.filter((o) => (spec.sentences ?? []).some((s) => s.id === o.id && s.source_video === o.source_video));
  if (spec.sentences?.length) {
    mkdirSync(join(final, "sentences"), { recursive: true });
    const look = report?.target ?? readJson(join(final, "even-target.json"), null);
    for (const s of spec.sentences) {
      if (sentenceDone(s)) continue;
      const job = report?.jobs?.find((j) => j.job === `job:${s.source_video}`);
      const plan = job?.before && look ? evenFilter(job.before, look, { color: spec.color !== false }) : null;
      const file = `sentences/${s.id}.mp4`;
      ffmpeg(["-i", s.video, "-vf", `${thin(s.every)}${plan ? plan.filter : "null"}`, ...CLIP_ENCODE, join(final, file)]);
      const frames = Math.ceil(s.frames / s.every);
      const i = sentences.findIndex((o) => o.id === s.id);
      const row = { id: s.id, file, source_video: s.source_video, evened: Boolean(plan), frames, seconds: Number((frames / 24).toFixed(3)), ...(s.meta ?? {}) };
      if (i >= 0) sentences[i] = row; else sentences.push(row);
      written.push(file);
    }
    writeJson(join(final, "sentences.json"), sentences);
    written.push("sentences.json");
  }
  writeJson(join(final, "manifest.json"), manifest);
  written.push("manifest.json");
  log(`manifest: ${Object.keys(manifest).length} entries (${aliases} aliases), ${sentences.length} sentence video(s)`);
  return { changed: written, clips: Object.keys(manifest).length, aliases, sentences: sentences.length, jobs_processed: changed.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--spec");
  if (i === -1) { console.error("usage: finish.mjs --spec SPEC.json"); process.exit(2); }
  const r = finish(JSON.parse(readFileSync(process.argv[i + 1], "utf8")));
  console.log(`FINISH_RESULT ${JSON.stringify(r)}`);
}
