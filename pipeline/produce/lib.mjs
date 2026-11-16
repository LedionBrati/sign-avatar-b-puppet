// Pure logic for pipeline/produce.mjs: sets, gloss -> motion, batch packing, exact Recast cost, the resumable
// state, the spend guard and best-take selection. No fal, no Modal, no ffmpeg here (unit tested in produce.test.mjs).

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AVATAR_PROMPT, RACE_MODELS, ltxFrames } from "../race/models.mjs";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const RENDER_FPS = 24;            // the avatar video is always written at 24 fps
export const SHOT_MAX_S = 15;            // Recast: no single shot over 15 s (one take is one shot)
export const PAID_TOKEN = "PROD-PAID";

/**
 * Repaint models (endpoints, input schemas and prices from pipeline/race/models.mjs). recast1080 won the race.
 *   minVideoS   the model's minimum input (shorter batches hold the last neutral)
 *   maxVideoS   longest single input we send (Recast: one shot <= 15 s; LTX: 481 frames)
 *   align8      LTX wants 8n+1 frames: batches are held to 8n+1 so output frames == input frames
 *   avatarImage the reference photo is part of the input (Recast); LTX render-to-real is prompt only
 */
export const MODELS = Object.freeze({
  recast1080: { race: "recast1080", minVideoS: 5, maxVideoS: SHOT_MAX_S, align8: false, avatarImage: true, prompt: null, resolution: "1080P" },
  recast768: { race: "recast", minVideoS: 5, maxVideoS: SHOT_MAX_S, align8: false, avatarImage: true, prompt: null, resolution: "768P" },
  ltx_r2r: { race: "ltx_r2r", minVideoS: 0, maxVideoS: 20, align8: true, avatarImage: false, prompt: AVATAR_PROMPT, resolution: "720p" },
});
export const AVATAR_MODELS = ["signer", "signer-bob"];
export const getModel = (name) => {
  const m = MODELS[name];
  if (!m) throw new Error(`--model must be one of ${Object.keys(MODELS).join(", ")}`);
  return { name, ...m, endpoint: RACE_MODELS[m.race].endpoint, price: RACE_MODELS[m.race].price, label: RACE_MODELS[m.race].label };
};

export const DEMO_GLOSSES = ["HELLO", "NICE", "MEET", "YOU", "WHERE", "HURT", "NEED", "WATER", "PLEASE", "THANK_YOU",
  "SEE", "LATER", "YES", "NO", "HUNGRY", "SICK", "HOME", "FINE", "HAPPY", "BYE"];

/**
 * Per set: compose fps (48 = half speed: rendered at 24 fps it plays at half speed, cut keeps every 2nd frame),
 * takes per batch, and the batch size in VIDEO seconds (what Recast sees and bills).
 */
export const SETS = Object.freeze({
  demo: { composeFps: 48, every: 2, takes: 1, maxVideoS: 14, score: true, priority: 0,
    note: "20 demo signs, half speed, best of N takes per sign (finger metric)" },
  sentences: { composeFps: 48, every: 2, takes: 1, maxVideoS: SHOT_MAX_S, score: true, priority: 1,
    note: "one continuous take per sentence, half speed; whole video + per-sign cuts" },
  library: { composeFps: 24, every: 1, takes: 1, maxVideoS: 10, score: true, priority: 2,
    note: "common-sign library, normal speed, batches packed to ~10 s" },
});

export const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
export const toId = (g) => String(g).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
export const glossKey = (g) => String(g).trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
export const displayGloss = (g) => String(g).replace(/_/g, " ").replace(/\s+/g, " ").trim().toUpperCase();

/** Exact price of one call of `model` on a video of `frames` frames at 24 fps (pipeline/race/models.mjs). */
export function modelCost(model, frames) {
  const m = typeof model === "string" ? getModel(model) : model;
  return RACE_MODELS[m.race].cost({ seconds: frames / RENDER_FPS, frames, fps: RENDER_FPS });
}
export const recastCost = (frames) => modelCost("recast1080", frames);

/** Frames the model returns for an input of `frames` frames (frame-exact models return the same). */
export const expectedOutFrames = (model, frames) => ((typeof model === "string" ? getModel(model) : model).align8 ? ltxFrames(frames) : frames);

/**
 * The fal input for one take. Recast: video + reference photo (+ seed, + prompt only if given: Recast works best
 * without one). LTX render-to-real: video + prompt (+ seed), no image unless `ltxImage`.
 */
export function modelInput(model, { videoUrl, avatarUrl, frames, seed = null, prompt = null, ltxImage = false }) {
  const m = typeof model === "string" ? getModel(model) : model;
  const v = { frames, fps: RENDER_FPS, seconds: frames / RENDER_FPS };
  const input = RACE_MODELS[m.race].input({ rgb: videoUrl, avatar: avatarUrl, avatarSmall: avatarUrl, firstFrame: null }, v);
  if (!m.avatarImage && !ltxImage) delete input.image_url;
  if (m.avatarImage && !avatarUrl) throw new Error(`${m.name} needs the avatar image`);
  if (seed !== null && seed !== undefined) input.seed = Number(seed);
  const p = prompt ?? m.prompt;
  if (p) input.prompt = p;
  return input;
}

/** Work / output folder suffix: the default product (recast1080 + signer) is just the set name. */
export function variantName(set, model = "recast1080", avatarModel = "signer") {
  if (!AVATAR_MODELS.includes(avatarModel)) throw new Error(`--avatar-model must be one of ${AVATAR_MODELS.join(", ")}`);
  return [set, model !== "recast1080" ? model : null, avatarModel !== "signer" ? avatarModel : null].filter(Boolean).join("-");
}

// ── Paths ───────────────────────────────────────────────────────────────────────

/** The checkout that holds the gitignored inputs (out/): --main, $SBP_MAIN, this repo, or its origin if local. */
export function findMain(explicit, { env = process.env, repo = REPO, originUrl } = {}) {
  const ok = (p) => p && existsSync(join(p, "out", "realtime", "neutral.clean.json"));
  for (const p of [explicit, env.SBP_MAIN]) if (p) { if (!ok(p)) throw new Error(`${p} has no out/realtime/neutral.clean.json`); return resolve(p); }
  if (ok(repo)) return repo;
  if (originUrl && !/^[a-z]+:\/\//i.test(originUrl) && ok(originUrl)) return resolve(originUrl);
  throw new Error("cannot find the checkout with out/ (pass --main or set SBP_MAIN)");
}

export function defaultPaths(main, env = process.env) {
  const first = (ps) => ps.find((p) => p && existsSync(p)) ?? ps.filter(Boolean)[0];
  return {
    neutral: join(main, "out/realtime/neutral.clean.json"),
    v2Root: join(main, "out/motion/wlasl3d"),
    cleanDir: join(main, "out/motion/wlasl"),
    index: first([env.SIGN_DICTIONARY, resolve(main, "../hackathon-archive/ai-summit/data/signs/index.json"), resolve(main, "../ai-summit/data/signs/index.json")]),
    realtime: join(main, "out/realtime"),
    workRoot: join(main, "out/produce"),
  };
}

export const outDirFor = (realtime, variant) => join(realtime, `clips-v2-${variant}`);

// ── Glosses -> motion ───────────────────────────────────────────────────────────

/** index.json {gloss: {file: "videos/<stem>.mp4"}} -> Map(glossKey -> stem). */
export function loadIndex(path) {
  const idx = JSON.parse(readFileSync(path, "utf8"));
  const out = new Map();
  for (const [g, e] of Object.entries(idx)) {
    const stem = e?.file ? basename(e.file).replace(/\.[^.]+$/, "") : null;
    if (stem) out.set(glossKey(g), stem);
  }
  return out;
}

/** Every <stem>.v2.json under root (recursive): Map(stem -> path). First found wins (sorted walk). */
export function scanV2(root) {
  const out = new Map();
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".v2.json")) { const stem = e.name.slice(0, -".v2.json".length); if (!out.has(stem)) out.set(stem, join(d, e.name)); }
    }
  };
  walk(root);
  return out;
}

/** Extraction QC of a motion dir (motion/batch_library.py): rows/<stem>.json, else summary.csv. Map(stem -> row). */
export function readQc(dir) {
  const out = new Map();
  if (!dir) return out;
  const p = join(dir, "summary.csv");
  if (existsSync(p)) {
    const [head, ...lines] = readFileSync(p, "utf8").trim().split(/\r?\n/);
    const cols = head.split(",");
    for (const line of lines) {
      const row = Object.fromEntries(line.split(",").map((v, k) => [cols[k], v]));
      if (row.name) out.set(row.name, row);
    }
  }
  const rows = join(dir, "rows");
  let files = [];
  try { files = readdirSync(rows).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of files) { try { out.set(f.slice(0, -5), JSON.parse(readFileSync(join(rows, f), "utf8"))); } catch {} }
  return out;
}

/** out/mass/state.json signs -> Map(stem -> {status, reason}) (kept / dropped by pipeline/mass/mass.mjs QA). */
export function readMassStatus(path) {
  const out = new Map();
  if (!path || !existsSync(path)) return out;
  try {
    for (const s of Object.values(JSON.parse(readFileSync(path, "utf8")).signs ?? {})) if (s?.stem) out.set(s.stem, { status: s.status, reason: s.reason ?? null });
  } catch {}
  return out;
}

/** Same thresholds as pipeline/mass/mass.mjs QA (a v1 clean motion is only used when it passes). */
export const QA = { minHandPct: 80, minFrames: 8, maxSeconds: 4, restLevel: 0.25, minRestFrames: 3 };

/** Longest run (frames) where both wrists sit near rest height between two active parts (mass.mjs restDip). */
export function restDip(motion) {
  const h = motion.frames.map((f) => {
    const p = f.poseWorld;
    if (!p) return null;
    const sh = (p[11][1] + p[12][1]) / 2;
    return Math.max(p[15][1] / sh, p[16][1] / sh);
  });
  const peak = Math.max(...h.map((v) => v ?? 0));
  const hi = Math.max(0.45, 0.6 * peak);
  const first = h.findIndex((v) => v > hi), last = h.findLastIndex((v) => v > hi);
  let best = 0, cur = 0;
  for (let i = first; i >= 0 && i <= last; i++) { if (h[i] !== null && h[i] < QA.restLevel) best = Math.max(best, ++cur); else cur = 0; }
  return best;
}

/**
 * Motion facts needed to plan (frames, fps, rest dip), cached on disk by path+size+mtime so a dry run over the whole
 * dictionary reads each 0.5 MB motion file once, ever.
 */
export function metaCache(path) {
  let data = {};
  if (path && existsSync(path)) { try { data = JSON.parse(readFileSync(path, "utf8")); } catch {} }
  let dirty = false;
  return {
    get(file) {
      const key = motionStamp(file);
      if (data[key]) return data[key];
      const m = JSON.parse(readFileSync(file, "utf8"));
      const v = { frames: m.frames.length, fps: m.fps, rest_dip: restDip(m), motion_id: m.motion_id ?? null, gloss: m.gloss ?? null };
      data[key] = v; dirty = true;
      return v;
    },
    save() { if (dirty && path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(`${path}.tmp`, JSON.stringify(data)); renameSync(`${path}.tmp`, path); dirty = false; } },
  };
}

/**
 * The motion library: prefer the WiLoR-fitted v2 file, else the v1 clean file if it passes QC.
 * QC for v1 (out/motion/wlasl): a mass.mjs verdict in out/mass/state.json when there is one, else the same checks
 * from rows/<stem>.json (extraction error, dominant hand seen in < 80 % of frames) and the motion (too short, longer
 * than 4 s or hands back at rest mid-sign: two signs suspected). v2 files are fitted and curated: only "too short".
 * @returns {{ resolve(gloss): {gloss, motion_id, stem, path, kind, frames, fps} | {gloss, error}, stems, v2Count }}
 */
export function motionLibrary({ index, v2Root, cleanDir, massState = null, meta = metaCache(null), qc = true, minHandPct = QA.minHandPct }) {
  const stems = typeof index === "string" ? loadIndex(index) : index;
  const v2 = v2Root instanceof Map ? v2Root : scanV2(v2Root);
  const rows = cleanDir ? readQc(cleanDir) : new Map();
  const mass = massState instanceof Map ? massState : readMassStatus(massState);
  const cache = new Map();
  const check = (stem, path, kind) => {
    const m = meta.get(path);
    const id = m.motion_id && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(m.motion_id) ? m.motion_id : null;
    const base = { stem, path, kind, frames: m.frames, fps: m.fps, motion_id: id, motion_gloss: m.gloss };
    if (!qc) return base;
    if (m.frames < QA.minFrames) return { stem, error: `too short (${m.frames} frames)` };
    if (kind === "v2") return base;
    const verdict = mass.get(stem);
    if (verdict?.status === "dropped") return { stem, error: `mass QA: ${verdict.reason}` };
    if (verdict?.status === "kept") return base;
    const row = rows.get(stem);
    if (row?.error) return { stem, error: `extraction failed: ${row.error}` };
    const pct = row ? Number(row.dominant_hand_pct_clean) : NaN;
    if (row && row.dominant_hand_pct_clean !== "" && Number.isFinite(pct) && pct < minHandPct) return { stem, error: `dominant hand seen in ${pct}% of frames (< ${minHandPct})` };
    const secs = m.frames / m.fps;
    if (secs > QA.maxSeconds) return { stem, error: `two signs suspected: ${secs.toFixed(2)} s > ${QA.maxSeconds} s` };
    if (m.rest_dip >= QA.minRestFrames) return { stem, error: `two signs suspected: hands at rest for ${m.rest_dip} frames mid-sign` };
    return base;
  };
  const lookup = (key) => {
    if (cache.has(key)) return cache.get(key);
    const stem = stems.get(key) ?? stems.get(key.replace(/ /g, "")) ?? null;
    let r;
    if (!stem) r = { error: "not in the sign index" };
    else if (v2.has(stem)) r = check(stem, v2.get(stem), "v2");
    else {
      const p = cleanDir && join(cleanDir, `${stem}.clean.json`);
      r = !p || !existsSync(p) ? { stem, error: "no v2 or clean motion" } : check(stem, p, "clean");
    }
    if (r.path && !r.motion_id) r.motion_id = toId(key);
    cache.set(key, r);
    return r;
  };
  return {
    resolve: (gloss) => ({ gloss: displayGloss(gloss), ...lookup(glossKey(gloss)) }),
    stems,
    v2Count: v2.size,
  };
}

/** Translator vocab without reading any motion: every dictionary gloss (QC runs on the planned signs only). */
export function dictionaryVocab(stems) {
  const seen = new Set(), out = [];
  for (const key of stems.keys()) {
    const id = toId(key);
    if (!id || seen.has(id) || /^[A-Z]$/.test(id)) continue;
    seen.add(id);
    out.push({ motion_id: id, gloss: displayGloss(key) });
  }
  return out;
}

/**
 * The whole dictionary for --set library, most frequent words first (wordfreq zipf, pipeline/produce/zipf.json).
 * Single letters are fingerspelling, not signs. Glosses that share one source video (WLASL reuses a clip for
 * synonyms) become ONE sign: the most frequent gloss, the others ride along as aliases (same clip, own manifest id).
 * @returns {{gloss: string, zipf: number|null, rank: number, aliases: string[]}[]}
 */
export function dictionaryGlosses(indexJson, zipf = {}) {
  const groups = new Map();
  for (const [g, e] of Object.entries(indexJson)) {
    if (/^[a-z]$/i.test(g.trim())) continue;
    const key = e?.source_url || e?.file || g;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  const z = (g) => (Number.isFinite(zipf[g]) ? zipf[g] : null);
  const order = (a, b) => (z(b) ?? -1) - (z(a) ?? -1) || a.localeCompare(b);
  const reps = [...groups.values()].map((gs) => { const [rep, ...aliases] = [...gs].sort(order); return { gloss: rep, zipf: z(rep), aliases }; });
  reps.sort((a, b) => order(a.gloss, b.gloss));
  return reps.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** "A,B C" or a file (one gloss per line, '#' comments, commas allowed). */
export function parseGlossList(spec, { readFile = (p) => readFileSync(p, "utf8"), exists = existsSync } = {}) {
  if (!spec) return [];
  const text = exists(spec) ? readFile(spec) : spec;
  return text.split(/\r?\n/).map((l) => l.replace(/#.*/, "")).flatMap((l) => (exists(spec) ? l.split(",") : l.split(/[,;]/)))
    .map((g) => g.trim()).filter(Boolean);
}

/** Sentences file: one sentence per line; blank lines and '#' comments skipped. */
export function parseSentences(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
}

// ── Batch length (exact, without building frames) ─────────────────────────────

/** Frames of one clip after retime() in puppet/src/blend.ts. */
export const clipFrames = (m, fps, holdEnd = 0) => Math.max(1, Math.round(((m.frames - 1) / m.fps + holdEnd) * fps) + 1);

/**
 * Frames of concatClips([NEUTRAL, S1, NEUTRAL, ..., NEUTRAL]) without building it (mirrors blend.ts exactly).
 * @param {{frames: number, fps: number}[]} signs   frame count + fps of each sign motion
 * @param {{frames: number, fps: number}} neutral
 */
export function batchFrames(signs, neutral, { fps, blend = 0.2, holdEnd = 0 }) {
  const parts = [clipFrames(neutral, fps)];
  for (const s of signs) parts.push(clipFrames(s, fps), clipFrames(neutral, fps));
  parts[parts.length - 1] = clipFrames(neutral, fps, holdEnd);
  let n = parts[0];
  for (let c = 1; c < parts.length; c++) {
    const overlap = Math.max(0, Math.min(Math.round(blend * fps), Math.floor(n / 2), Math.floor(parts[c] / 2)));
    n += parts[c] - overlap;
  }
  return n;
}



/**
 * Split signs (in order) into the fewest batches whose video is <= maxVideoS, balanced in length (make-batches.mjs).
 * Order is kept, so with the library sorted by word frequency the first batches hold the most common words.
 * @param {{frames, fps}[]} signs
 * @returns {number[][]} indices per batch
 */
export function packBatches(signs, neutral, { fps, blend = 0.2, maxVideoS }) {
  if (!signs.length) return [];
  const videoS = (ids) => batchFrames(ids.map((i) => signs[i]), neutral, { fps, blend }) / RENDER_FPS;
  for (let i = 0; i < signs.length; i++) {
    if (videoS([i]) > maxVideoS) throw Object.assign(new Error(`alone it is ${videoS([i]).toFixed(2)} s of video (> ${maxVideoS} s)`), { sign: i });
  }
  // Greedy with a per-batch limit: the smallest limit (from total / count up) that still needs only `count` batches.
  const split = (limit) => {
    const out = [];
    let cur = [];
    for (let i = 0; i < signs.length; i++) {
      const trial = cur.length ? videoS([...cur, i]) : 0;
      if (cur.length && trial > limit) { out.push(cur); cur = [i]; } else cur.push(i);
    }
    if (cur.length) out.push(cur);
    return out;
  };
  const greedy = split(maxVideoS);
  if (greedy.length === 1) return greedy;
  const total = videoS(signs.map((_, i) => i));
  const count = greedy.length;
  for (let limit = Math.max(total / count, 0); limit < maxVideoS; limit += 0.05) {
    const b = split(limit);
    if (b.length <= count) return b;
  }
  return greedy;
}

/** Pure (unblended) neutral frames at each inner pause: the cut lands on a still pose (make-batches.mjs --min-pure). */
export function innerPureNeutral(segments) {
  return segments.map((s, i) => {
    if (s.gloss) return null;
    const a = i > 0 ? segments[i - 1].end + 1 : s.start;
    const b = i < segments.length - 1 ? segments[i + 1].start - 1 : s.end;
    return b - a + 1;
  }).filter((x) => x !== null).slice(1, -1);
}

/** Stable batch name from its content, so re-planning finds the same batch in the state file. */
export function batchName(set, parts) {
  const h = createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 8);
  return `${set}-${h}`;
}

/** Fingerprint of a motion file (path + size + mtime): a changed motion is a different batch. */
export function motionStamp(path) {
  try { const s = statSync(path); return `${resolve(path)}:${s.size}:${Math.round(s.mtimeMs)}`; } catch { return `${path}:missing`; }
}

// ── State (resumable; a paid batch is never paid again) ─────────────────────────

export function newState(set) {
  return { version: 1, set, created_at: new Date().toISOString(), spent_usd: 0, batches: {}, qc_rejected: {}, runs: [] };
}
export function loadState(path, set) {
  if (!existsSync(path)) return newState(set);
  const s = JSON.parse(readFileSync(path, "utf8"));
  if (s.set !== set) throw new Error(`${path} is the state of set ${s.set}, not ${set}`);
  s.qc_rejected ??= {};
  return s;
}
export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
}

// Take statuses: planned -> submitting (call started) -> submitted (request id saved) -> completed (result URL saved)
// -> done | rejected (paid, but the output frame count did not match: never cut) | failed_after_submit. "submitting" without a request id means we cannot know whether
// fal took the job: it is treated as paid and never resubmitted automatically (--resubmit-unknown).
const PAID = new Set(["submitting", "submitted", "completed", "done", "rejected", "failed_after_submit"]);
/** A take that may have cost money. */
export const takeIsPaid = (t) => PAID.has(t?.status);
export const batchIsPaid = (b) => (b?.takes ?? []).some(takeIsPaid);
export const doneTakes = (b) => (b?.takes ?? []).filter((t) => t.status === "done");
export const paidTakes = (b) => (b?.takes ?? []).filter(takeIsPaid).length;

/**
 * Signs already covered by a batch with spend (frozen: never re-packed, never paid again).
 * @returns {Map<motion_id, {batch, kind}>}
 */
export function coveredSigns(state) {
  const out = new Map();
  for (const b of Object.values(state.batches)) {
    if (!batchIsPaid(b)) continue;
    for (const s of b.signs) if (!out.has(s.motion_id)) out.set(s.motion_id, { batch: b.name, kind: s.kind });
  }
  return out;
}

/**
 * Spend guard: the hard cap is checked before EVERY paid call. `spentThisRun` is what this invocation has
 * committed so far (the state also keeps the lifetime total).
 */
export function guardSpend({ spentThisRun, cost, maxUsd }) {
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("--max-usd must be a positive number");
  if (!Number.isFinite(cost) || cost <= 0) throw new Error(`bad cost ${cost}`);
  const after = round(spentThisRun + cost, 3);
  if (after > maxUsd + 1e-9) {
    const e = new Error(`next call costs $${cost.toFixed(3)}; this run has committed $${spentThisRun.toFixed(3)} of --max-usd $${maxUsd}: stopping before the call`);
    e.code = "max_usd";
    throw e;
  }
  return after;
}

/** Seeds for the takes of a batch (different per take, same across runs). */
export const takeSeeds = (n, base = 4242) => Array.from({ length: n }, (_, k) => base + k);

/** The first batches (in plan order) whose remaining cost fits in `usd`. */
export function budgetPrefix(batches, usd, remainingCost) {
  const out = [];
  let sum = 0;
  for (const b of batches) {
    const c = remainingCost(b);
    if (c <= 0) { out.push(b); continue; }
    if (sum + c > usd + 1e-9) break;
    sum += c;
    out.push(b);
  }
  return out;
}

// ── Render QC gate (before any paid call) ───────────────────────────────────────

/**
 * Render QC thresholds (same as render.mjs summarizeBadFrames): palm / hand dir > 60 deg or fingers > 50 deg is a bad
 * hand frame; > 3 % bad frames in a sign, or any palm flip (> 90 deg in one frame), rejects the sign.
 * Arms: with --placement ik the arm leaves the tracker's direction on purpose, so the arm angle check is off (armDeg
 * null) and the location block is used instead: a frame whose hand-to-face/shoulder distance error (shoulder widths,
 * render.mjs "location") exceeds locMax (0.6: a gross misplacement; the final renderer's worst frames are ~0.5) is bad.
 * armDeg 45 is the check for --placement fk.
 */
export const RENDER_QC = { handDeg: 60, palmDeg: 60, fingersDeg: 50, armDeg: null, locMax: 0.6, maxBadPct: 3, palmFlipDeg: 90 };
export const renderQcFor = (placement, o = {}) => ({ ...RENDER_QC, armDeg: placement === "fk" ? 45 : null, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) });

const angle = (a, b) => {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2], n = Math.hypot(...a) * Math.hypot(...b);
  return n > 0 ? (Math.acos(Math.max(-1, Math.min(1, d / n))) * 180) / Math.PI : 0;
};

/**
 * Per-frame verdict from one render report frame (puppet/render.mjs: per_frame[i].err in degrees per part).
 * Explicit report fields win when the renderer provides them (bad / bad_frame, palm_flip, palm normals).
 * @returns {{bad: string[], palm: {L?: number[], R?: number[]}|null, palmErr: {L?: number, R?: number}, flip: string[]}}
 */
export function frameQc(f, t = RENDER_QC) {
  const bad = [], flip = [];
  if (!f) return { bad, flip, palm: null, palmErr: {} };
  const err = f.err ?? {};
  const over = (k, lim) => { const v = err[k]; if (v !== null && v !== undefined && lim !== null && v > lim) bad.push(`${k} ${Math.round(v)}°`); };
  for (const S of ["L", "R"]) {
    over(`${S} hand dir`, t.handDeg); over(`${S} palm`, t.palmDeg); over(`${S} fingers`, t.fingersDeg);
    over(`${S} upper arm`, t.armDeg); over(`${S} forearm`, t.armDeg);
  }
  // hand location vs the source (render.mjs per_frame loc: {side: {src: [..], av: [..]}}, shoulder widths)
  if (t.locMax !== null && t.locMax !== undefined) {
    for (const [S, l] of Object.entries(f.loc ?? {})) {
      if (!l?.src || !l?.av) continue;
      const e = Math.max(...l.src.map((v, k) => Math.abs((l.av[k] ?? v) - v)));
      if (e > t.locMax) bad.push(`${S} location off by ${e.toFixed(2)} shoulder widths`);
    }
  }
  const explicitBad = f.bad ?? f.bad_frame;
  if (explicitBad === true) bad.push("renderer: bad frame");
  else if (Array.isArray(explicitBad)) bad.push(...explicitBad.map((x) => `renderer: ${x}`));
  if (f.palm_flip === true) flip.push("renderer: palm flip");
  else if (f.palm_flip && typeof f.palm_flip === "object") for (const [S, v] of Object.entries(f.palm_flip)) if (v) flip.push(`${S} palm flip (renderer)`);
  const palm = f.palmN ?? f.palm_n ?? f.palm_normal ?? null;   // render.mjs per_frame palmN: the avatar's own palm normals
  return { bad, flip, palm, palmErr: { L: err["L palm"] ?? null, R: err["R palm"] ?? null } };
}

/**
 * The render QC gate for one batch: per sign segment, the share of bad frames and any palm flip (palm orientation
 * changing > 90 deg between neighbouring frames: from the renderer's palm normals when it reports them, else from a
 * > 90 deg jump of the palm error, i.e. the avatar's palm turning over against a source that did not).
 * @param {object} report        render.mjs report (per_frame)
 * @param {{gloss, start, end}[]} segments   composed-frame segments (render frame i = motion frame i)
 * @param {{motion_id}[]} signs  batch signs in segment order
 * @returns {{ok: boolean, signs: {motion_id, gloss, frames, bad_frames, bad_pct, palm_flips, pass, reasons[]}[], totals}}
 */
export function renderQc(report, segments, signs, t = RENDER_QC) {
  const frames = report?.per_frame ?? [];
  const qs = frames.map((f) => frameQc(f, t));
  const flipAt = (i) => {
    const out = [...(qs[i]?.flip ?? [])];
    if (i > 0 && qs[i] && qs[i - 1]) {
      for (const S of ["L", "R"]) {
        const a = qs[i - 1].palm?.[S], b = qs[i].palm?.[S];
        if (a && b) { if (angle(a, b) > t.palmFlipDeg) out.push(`${S} palm turned ${Math.round(angle(a, b))}° in one frame`); continue; }
        const ea = qs[i - 1].palmErr[S], eb = qs[i].palmErr[S];
        if (ea !== null && ea !== undefined && eb !== null && eb !== undefined && Math.abs(eb - ea) > t.palmFlipDeg) out.push(`${S} palm error jumped ${Math.round(ea)}° -> ${Math.round(eb)}°`);
      }
    }
    return out;
  };
  const signSegs = segments.filter((s) => s.gloss);
  const rows = signSegs.map((s, k) => {
    let n = 0, badN = 0;
    const flips = [], examples = [];
    for (let i = s.start; i <= s.end; i++) {
      n++;
      if (qs[i]?.bad.length) { badN++; if (examples.length < 3) examples.push(`f${i}: ${qs[i].bad.join(", ")}`); }
      for (const x of flipAt(i)) flips.push(`f${i}: ${x}`);
    }
    const badPct = n ? round((100 * badN) / n, 1) : 0;
    const reasons = [];
    if (!frames.length) reasons.push("render report has no per-frame data");
    if (flips.length) reasons.push(`palm flip (${flips.slice(0, 3).join("; ")})`);
    if (badPct > t.maxBadPct) reasons.push(`${badPct}% bad frames > ${t.maxBadPct}% (${examples.join("; ")})`);
    return { motion_id: signs[k]?.motion_id ?? null, gloss: s.gloss, frames: n, bad_frames: badN, bad_pct: badPct, palm_flips: flips.length, pass: reasons.length === 0, reasons };
  });
  return { ok: rows.every((r) => r.pass), signs: rows, thresholds: t };
}

// ── Best take per sign ──────────────────────────────────────────────────────────

/**
 * Rank key for one sign in one take, lower is better. Handshape changes against the source hands come first (a
 * changed handshape is a wrong sign), then joint error, then a lost hand. Falls back to the puppet video when the
 * motion has no hands for the sign. Unscored takes rank last but stay usable.
 */
export function signKey(score) {
  if (!score) return [Infinity, Infinity, Infinity];
  const m = score.vs_motion ?? {}, r = score.vs_ref ?? {};
  const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const shape = num(m.handshape_change_pct) ?? num(r.handshape_change_pct);
  const err = num(m.mean_joint_err_deg) ?? num(r.mean_joint_err_deg);
  const drop = num(r.drop_pct) ?? 0;
  if (shape === null && err === null) return [Infinity, Infinity, drop];
  return [shape ?? 100, err ?? 180, drop];
}
const cmpKey = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };

/**
 * Pick the best done take for every sign of a batch.
 * @returns {{motion_id, gloss, kind, aliases, index, take, key, score}[]}   one row per sign (take null when none is done)
 */
export function pickBest(batch) {
  const takes = doneTakes(batch);
  return batch.signs.map((s, index) => {
    let best = null;
    for (const t of takes) {
      const sc = t.scores?.per_sign?.find((p) => p.index === index) ?? null;
      const key = signKey(sc);
      if (!best || cmpKey(key, best.key) < 0) best = { take: t.k, key, score: sc };
    }
    return { batch: batch.name, motion_id: s.motion_id, gloss: s.gloss, kind: s.kind, aliases: s.aliases ?? [], index,
      take: best?.take ?? null, key: best?.key ?? null, score: best?.score ?? null };
  });
}

/**
 * Across batches (sentences repeat signs; a sign redone with a newer v2 motion): the single best clip per motion_id.
 * A v2 (fitted hands) clip beats a v1 clip, then the finger key decides; ties keep the earlier batch.
 * @returns {Map<string, object>} motion_id -> row
 */
export function bestPerSign(rows) {
  const out = new Map();
  const full = (r) => [r.kind === "v2" ? 0 : 1, ...r.key];
  for (const r of rows) {
    if (r.take === null) continue;
    const cur = out.get(r.motion_id);
    if (!cur || cmpKey(full(r), full(cur)) < 0) out.set(r.motion_id, r);
  }
  return out;
}

/** Cut points of NEUTRAL S1 NEUTRAL ... NEUTRAL in the thinned video (same as pipeline/lib/clips.mjs cutPoints). */
export function cutPoints(segments, every = 1) {
  const mids = segments.filter((s) => !s.gloss).map((s) => Math.floor((s.start + s.end) / 2 / every));
  const signs = segments.filter((s) => s.gloss);
  if (mids.length !== signs.length + 1) throw new Error("expected NEUTRAL around every sign");
  return signs.map((s, k) => ({ gloss: s.gloss, a: mids[k], b: mids[k + 1] }));
}

// ── Server priority ─────────────────────────────────────────────────────────────

/** clips-v2-<set> folders in priority order: demo, sentences, library; variants (other models) are never auto-picked. */
export function v2Order(names) {
  const rank = (n) => { const set = n.replace(/^clips-v2-/, ""); return SETS[set] ? SETS[set].priority : null; };
  return names.filter((n) => rank(n) !== null).sort((a, b) => rank(a) - rank(b));
}
