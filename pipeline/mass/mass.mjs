#!/usr/bin/env node
// Mass pipeline: WLASL signs -> realistic per-sign avatar clips, most frequent English words first.
// The real-time method from experiments/2026-11-15-sentences-and-benchmarks.md, at scale:
// NEUTRAL S1 NEUTRAL S2 ... batches -> puppet render -> one H3 Max Recast per batch -> cut at
// the neutral midpoints -> one clip per sign in out/realtime/clips-mass/ (own manifest.json).
//
// Resumable and idempotent: every stage skips work that is already done. State: out/mass/state.json.
//
//   node pipeline/mass/mass.mjs rank                         # out/mass/ranked.json (wordfreq zipf)
//   node pipeline/mass/mass.mjs extract --top 300 [--workers 3] [--chunk 60]   # free, MediaPipe, + QA
//   node pipeline/mass/mass.mjs batch   --top 300 [--max-seconds 12]          # free, make-batches.mjs
//   node pipeline/mass/mass.mjs render  [--limit K] [--cpu]                    # free, one at a time, GPU
//   node pipeline/mass/mass.mjs run     --top 300                              # rank+extract+batch+render
//   node pipeline/mass/mass.mjs repaint --top 300 --dry-run                    # plan + cost/time, free
//   FAL_KEY=... node pipeline/mass/mass.mjs repaint --top 300 --execute --budget-usd 40 [--concurrency 2]
//   node pipeline/mass/mass.mjs status [--top 300]
//
// PAID: only `repaint --execute`. It needs FAL_KEY in the environment (never in a file or log),
// --budget-usd (a cap on the TOTAL recorded in state.json across all runs, checked before every
// call), and goes through the gated harness pipeline/e0.mjs (--authorize-paid E0-PAID --max-usd N).
//
// Paths (flag or env; relative defaults are from the repo root, "realtime" = out/realtime):
//   --index       MASS_INDEX       WLASL index.json (videos resolve relative to it); required by rank / extract
//   --motion-dir  MASS_MOTION_DIR  extractor output (raw/clean JSON + rows/), shared and resumable (out/motion/wlasl)
//   --extractor   MASS_EXTRACTOR   motion/ folder with .venv + MediaPipe model (batch_library.py) (motion)
//   --neutral     MASS_NEUTRAL     the shared neutral pose, same as the existing clips (realtime/neutral.clean.json)
//   --existing    MASS_EXISTING    comma list: clip manifests and batch dirs whose signs are already done
//                                  (realtime/clips/manifest.json,realtime/vocab)
//   --clips-dir   MASS_CLIPS_DIR   output clip set (out/realtime/clips-mass)

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, createWriteStream } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ffprobePath } from "../../shared/ffmpeg.mjs";
import { toId } from "../lib/clips.mjs";
import { MODELS } from "../e0/models.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const [cmd = "help", ...rest] = process.argv.slice(2);
const BOOL = new Set(["dry-run", "execute", "simulate", "cpu", "retry-failed", "rerank", "flush"]);
const opt = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, "");
  if (BOOL.has(k)) opt[k] = true;
  else opt[k] = rest[++i];
}
const env = process.env;
const REALTIME = join(ROOT, "out/realtime");
const INDEX = opt.index ?? env.MASS_INDEX;
const C = {
  get index() {
    if (!INDEX) throw new Error("no WLASL library index: pass --index <path-to>/index.json or set MASS_INDEX");
    return resolve(INDEX);
  },
  motionDir: resolve(opt["motion-dir"] ?? env.MASS_MOTION_DIR ?? join(ROOT, "out/motion/wlasl")),
  extractor: resolve(opt.extractor ?? env.MASS_EXTRACTOR ?? join(ROOT, "motion")),
  neutral: resolve(opt.neutral ?? env.MASS_NEUTRAL ?? join(REALTIME, "neutral.clean.json")),
  existing: String(opt.existing ?? env.MASS_EXISTING ??
    `${join(REALTIME, "clips/manifest.json")},${join(REALTIME, "vocab")}`)
    .split(",").map((p) => p.trim()).filter(Boolean),
  clips: resolve(opt["clips-dir"] ?? env.MASS_CLIPS_DIR ?? join(ROOT, "out/realtime/clips-mass")),
  out: join(ROOT, "out/mass"),
  runs: join(ROOT, "experiments/e0/runs/mass"),
};
const TOP = Number(opt.top ?? 300);
const FPS = 24;
const QA = { minHandPct: 80, minFrames: 8, maxSeconds: 4, restLevel: 0.25, minRestFrames: 3 };
const LISTED_USD_PER_S = 0.085;            // H3 Max Recast listed price (fal model page, 15 Nov 2026)
const FAL_S_PER_VIDEO_S = 15;              // measured 10.8-15.6 s of fal time per second of video
const FAL_OVERHEAD_S = 20;                 // upload + queue + download per call
const RESOLUTION = opt.resolution ?? "768P";

// ---------------------------------------------------------------- helpers
const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const save = (p, data) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p + ".tmp", JSON.stringify(data, null, 1)); renameSync(p + ".tmp", p); };
const statePath = join(C.out, "state.json");
const rankedPath = join(C.out, "ranked.json");
const loadState = () => existsSync(statePath) ? load(statePath) : { version: 1, signs: {}, batches: {}, chunks: 0 };
// --simulate (free wiring test of the repaint stage): never writes state.json
const saveState = (s) => { if (opt.simulate) return; s.updated = new Date().toISOString(); save(statePath, s); };
const loadRanked = () => { if (!existsSync(rankedPath)) throw new Error("run `rank` first"); return load(rankedPath); };
const usd = (x) => `$${x.toFixed(2)}`;
const hms = (s) => s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`;
const frameCount = (mp4) => Number(execFileSync(ffprobePath(), ["-v", "error", "-count_frames", "-select_streams", "v:0",
  "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", mp4]).toString().trim());

const children = new Set();
function killAll() {
  for (const c of children) {
    try { process.platform === "win32" ? spawnSync("taskkill", ["/T", "/F", "/PID", String(c.pid)], { stdio: "ignore" }) : c.kill("SIGKILL"); } catch {}
  }
  children.clear();
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { console.error(`\n${sig}: stopping children (state is saved after every step)`); killAll(); process.exit(130); });

/** Run a child, tee its output to `log` (and to our stdout unless quiet). Resolves {code, out}. */
function run(bin, args, { cwd = ROOT, log, quiet = false, show = null, env: extra } = {}) {
  return new Promise((res) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    const file = log ? (mkdirSync(dirname(log), { recursive: true }), createWriteStream(log)) : null;
    let out = "";
    const onData = (d) => {
      const s = d.toString(); out += s; file?.write(s);
      if (show) { for (const l of s.split(/\r?\n/)) if (show.test(l)) process.stdout.write(l + "\n"); } else if (!quiet) process.stdout.write(s);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => { children.delete(child); file?.end(); res({ code, out }); });
  });
}

// ---------------------------------------------------------------- rank
function existingIds() {
  const ids = new Map();
  for (const p of C.existing) {
    if (!existsSync(p)) { console.warn(`existing: ${p} not found, skipped`); continue; }
    if (p.endsWith(".json")) {
      for (const [id, e] of Object.entries(load(p))) ids.set(id, `${basename(dirname(p))}/manifest.json (${e.gloss ?? id})`);
    } else {
      for (const f of readdirSync(p).filter((f) => f.endsWith(".json") && !f.endsWith("-vrm.json"))) {
        const j = load(join(p, f));
        for (const s of j.segments ?? []) if (s.gloss) ids.set(toId(s.gloss), `${basename(p)}/${f}`);
      }
    }
  }
  return ids;
}

function rank() {
  const index = load(C.index);
  const libDir = dirname(C.index);
  const glosses = Object.keys(index);
  console.log(`rank: ${glosses.length} glosses in ${C.index}`);
  const z = spawnSync("uv", ["run", "--no-project", "--quiet", "--with", "wordfreq", "python", join(import.meta.dirname, "zipf.py")],
    { input: JSON.stringify(glosses), encoding: "utf8", maxBuffer: 64 << 20 });
  if (z.status !== 0) throw new Error(`zipf.py failed: ${z.stderr}`);
  const freq = JSON.parse(z.stdout);
  const done = existingIds();
  const skipped = [];
  // Identical video files (WLASL reuses one SignSchool clip for synonyms) -> one sign, aliases.
  const groups = new Map();
  for (const g of glosses) {
    const p = join(libDir, index[g].file);
    if (!existsSync(p)) { skipped.push({ gloss: g, reason: "no_video" }); continue; }
    const h = createHash("md5").update(readFileSync(p)).digest("hex");
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(g);
  }
  const letter = (g) => /^[a-z]$/.test(g);
  const ranked = [];
  for (const members of groups.values()) {
    members.sort((a, b) => freq[b].zipf - freq[a].zipf || a.localeCompare(b));
    const words = members.filter((g) => !letter(g));
    for (const g of members.filter(letter)) skipped.push({ gloss: g, reason: "letter (fingerspelling unit, not a word sign)" });
    if (!words.length) continue;
    const hit = words.find((g) => done.has(toId(g)));
    if (hit) { for (const g of words) skipped.push({ gloss: g, reason: `already_realistic: ${done.get(toId(hit))}${g === hit ? "" : ` (alias of ${hit})`}` }); continue; }
    const [rep, ...aliases] = words;
    for (const a of aliases) skipped.push({ gloss: a, reason: `alias_of ${rep} (identical video file)` });
    const e = index[rep];
    ranked.push({ gloss: rep, id: toId(rep), zipf: freq[rep].zipf, parts: freq[rep].parts, aliases,
      stem: basename(e.file, ".mp4"), file: e.file, signer: e.signer_id ?? null, source_url: e.source_url });
  }
  ranked.sort((a, b) => b.zipf - a.zipf || a.gloss.localeCompare(b.gloss));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  const ids = new Map();
  for (const r of ranked) { if (ids.has(r.id)) throw new Error(`clip id collision: ${r.gloss} / ${ids.get(r.id)}`); ids.set(r.id, r.gloss); }
  save(rankedPath, {
    created: new Date().toISOString(), index: C.index,
    method: "wordfreq zipf_frequency(word, 'en'); multiword gloss = min over its words; identical video files grouped (most frequent gloss kept, others aliases); single letters and already-realistic signs skipped",
    counts: { glosses: glosses.length, ranked: ranked.length, skipped: skipped.length },
    ranked, skipped,
  });
  const why = {};
  for (const s of skipped) { const k = s.reason.split(/[ :]/)[0]; why[k] = (why[k] ?? 0) + 1; }
  console.log(`rank: ${ranked.length} signs ranked, skipped ${JSON.stringify(why)} -> ${rankedPath}`);
  console.log(`top 20: ${ranked.slice(0, 20).map((r) => `${r.gloss}(${r.zipf})`).join(" ")}`);
}

// ---------------------------------------------------------------- extract + QA
const rowPath = (stem) => join(C.motionDir, "rows", `${stem}.json`);

/** Longest run (frames) where BOTH wrists sit near rest height between two active parts of the sign. */
function restDip(motion) {
  const h = motion.frames.map((f) => {
    const p = f.poseWorld;
    if (!p) return null;
    const sh = (p[11][1] + p[12][1]) / 2;               // poseWorld: y down, origin between the hips
    return Math.max(p[15][1] / sh, p[16][1] / sh);      // 0 = hip height, 1 = shoulder height
  });
  const peak = Math.max(...h.map((v) => v ?? 0));
  const hi = Math.max(0.45, 0.6 * peak);
  const first = h.findIndex((v) => v > hi), last = h.findLastIndex((v) => v > hi);
  let best = 0, cur = 0;
  for (let i = first; i >= 0 && i <= last; i++) { if (h[i] !== null && h[i] < QA.restLevel) best = Math.max(best, ++cur); else cur = 0; }
  return best;
}

function qa(r) {
  const row = load(rowPath(r.stem));
  const res = { stem: r.stem, hand_pct: Number(row.dominant_hand_pct_clean) || 0, mirrored: row.mirrored === 1 || row.mirrored === "1", flags: [] };
  if (row.error) return { ...res, status: "dropped", reason: `extract_error: ${row.error}` };
  const clean = join(C.motionDir, `${r.stem}.clean.json`);
  if (!existsSync(clean)) return { ...res, status: "dropped", reason: "no_clean_motion" };
  const m = load(clean);
  Object.assign(res, { motion: clean, frames: m.frames.length, seconds: Number((m.frames.length / m.fps).toFixed(2)) });
  // Informational: SignSchool titles list synonyms ("Agree, Agreement"); WLASL cut the whole
  // file, which shows ONE sign. Kept, flagged for the signer review.
  if (/,/.test(decodeURIComponent(String(r.source_url ?? "").split("/").pop()))) res.flags.push("multi_title_source");
  if (res.mirrored) res.flags.push("mirrored_left_handed_signer");
  if (res.hand_pct < QA.minHandPct) return { ...res, status: "dropped", reason: `hand_detected_${res.hand_pct}%<${QA.minHandPct}%` };
  if (res.frames < QA.minFrames) return { ...res, status: "dropped", reason: `too_short_${res.frames}_frames` };
  if (res.seconds > QA.maxSeconds) return { ...res, status: "dropped", reason: `two_signs_suspected: ${res.seconds}s trimmed span > ${QA.maxSeconds}s` };
  const dip = restDip(m);
  res.rest_dip_frames = dip;
  if (dip >= QA.minRestFrames) return { ...res, status: "dropped", reason: `two_signs_suspected: hands back at rest for ${dip} frames mid-sign` };
  return { ...res, status: "kept" };
}

function qaAll(state, top) {
  const { ranked } = loadRanked();
  let n = 0;
  for (const r of ranked.slice(0, top)) {
    if (!existsSync(rowPath(r.stem))) continue;
    const prev = state.signs[r.gloss] ?? {};
    state.signs[r.gloss] = { ...prev, rank: r.rank, id: r.id, zipf: r.zipf, aliases: r.aliases, ...qa(r) };
    if (state.signs[r.gloss].status === "dropped" && prev.batch) state.signs[r.gloss].status = "kept"; // never pull a batched sign
    n++;
  }
  return n;
}

async function extract() {
  const workers = Math.min(3, Number(opt.workers ?? 3));   // laptop thermal limit: never more than 3
  const { ranked } = loadRanked();
  const top = ranked.slice(0, TOP);
  const done = top.filter((r) => existsSync(rowPath(r.stem)));
  let todo = top.filter((r) => !existsSync(rowPath(r.stem)));
  if (opt.chunk) todo = todo.slice(0, Number(opt.chunk));
  console.log(`extract: top ${TOP}: ${done.length} already extracted, ${todo.length} to do now, ${workers} workers`);
  if (todo.length) {
    const index = load(C.index);
    const sub = Object.fromEntries([...done, ...todo].map((r) => [r.gloss, index[r.gloss]]));
    const subPath = join(dirname(C.index), "index.mass.json");   // next to the library index, so videos/... resolve
    writeFileSync(subPath, JSON.stringify(sub, null, 1));
    const py = [join(C.extractor, ".venv/Scripts/python.exe"), join(C.extractor, ".venv/bin/python")].find(existsSync);
    const [bin, pre] = py ? [py, []] : ["uv", ["run", "python"]];
    const t0 = Date.now();
    const { code } = await run(bin, [...pre, "batch_library.py", "--index", subPath, "--out-dir", C.motionDir, "--workers", String(workers)],
      { cwd: C.extractor, log: join(C.out, "logs", `extract-${Date.now()}.log`), env: { PYTHONUNBUFFERED: "1" },
        show: /^\{"(gloss|done)"|signs selected|Error|Traceback/ });
    console.log(`extract: exit ${code}, ${todo.length} signs in ${hms((Date.now() - t0) / 1000)} (${((Date.now() - t0) / 1000 / todo.length).toFixed(1)} s/sign wall)`);
    if (code !== 0) throw new Error(`extractor exited ${code}`);
  }
  const state = loadState();
  const n = qaAll(state, TOP);
  saveState(state);
  const signs = Object.values(state.signs).filter((s) => s.rank <= TOP);
  console.log(`qa: ${n} checked, kept ${signs.filter((s) => s.status === "kept").length}, dropped ${signs.filter((s) => s.status === "dropped").length}`);
}

// ---------------------------------------------------------------- batch
async function batch() {
  const state = loadState();
  const pending = Object.entries(state.signs).filter(([, s]) => s.status === "kept" && !s.batch && s.rank <= TOP)
    .sort((a, b) => a[1].rank - b[1].rank);
  console.log(`batch: ${pending.length} kept signs in the top ${TOP} not batched yet`);
  const CHUNK = Number(opt["chunk-signs"] ?? 40);
  for (let i = 0; i < pending.length; i += CHUNK) {
    const part = pending.slice(i, i + CHUNK);
    const prefix = `mass-${String(state.chunks + 1).padStart(3, "0")}`;
    const outDir = join(C.out, "batches");
    const { code, out } = await run(process.execPath, ["--experimental-strip-types", "--no-warnings", "pipeline/make-batches.mjs",
      "--neutral", C.neutral, "--out-dir", outDir, "--prefix", prefix, "--max-seconds", String(opt["max-seconds"] ?? 12),
      ...part.map(([g, s]) => `${g}=${s.motion}`)], { quiet: true });
    if (code !== 0) throw new Error(`make-batches failed:\n${out}`);
    for (const line of out.split(/\r?\n/).filter((l) => l.startsWith("{"))) {
      const b = JSON.parse(line);
      const seg = load(join(outDir, `${b.batch}.json`));
      state.batches[b.batch] = { signs: b.signs, frames: b.frames, seconds: b.seconds, padded_s: b.padded_s,
        min_pure_neutral_frames: b.min_pure_neutral_frames, motion: join(outDir, `${b.batch}.clean.json`),
        segments: join(outDir, `${b.batch}.json`), min_rank: Math.min(...b.signs.map((g) => state.signs[g].rank)) };
      for (const g of b.signs) state.signs[g].batch = b.batch;
      if (seg.frames !== b.frames) throw new Error(`${b.batch}: segments file disagrees`);
      console.log(`  ${b.batch}: ${b.signs.length} signs, ${b.frames} frames, ${b.seconds} s${b.padded_s ? ` (padded ${b.padded_s} s)` : ""}`);
    }
    state.chunks++;
    saveState(state);
  }
}

// ---------------------------------------------------------------- render
async function render() {
  const state = loadState();
  const todo = Object.entries(state.batches).filter(([, b]) => !b.render?.ok).sort(([a], [b]) => a.localeCompare(b));
  const limit = Number(opt.limit ?? todo.length);
  console.log(`render: ${todo.length} batches not rendered, doing ${Math.min(limit, todo.length)} (one at a time, ${opt.cpu ? "software" : "GPU"} WebGL)`);
  for (const [name, b] of todo.slice(0, limit)) {
    const mp4 = join(C.out, "render", `${name}-vrm.mp4`);
    const t0 = Date.now();
    const { code, out } = await run(process.execPath, ["puppet/render.mjs", "--motion", b.motion, "--view", "vrm", "--out", mp4, ...(opt.cpu ? [] : ["--gpu"])],
      { log: join(C.out, "logs", `render-${name}.log`), quiet: true });
    const wall = (Date.now() - t0) / 1000;
    const frames = existsSync(mp4) ? frameCount(mp4) : 0;
    const spf = Number(/([\d.]+) s\/frame/.exec(out)?.[1] ?? NaN);
    const webgl = /webgl: (.*) \((hardware|software)\)/.exec(out);
    b.render = { mp4, frames, ok: code === 0 && frames === b.frames, s_per_frame: spf, wall_s: Number(wall.toFixed(1)), webgl: webgl?.[2] ?? null };
    saveState(state);
    console.log(`  ${name}: ${frames}/${b.frames} frames, ${spf} s/frame, ${wall.toFixed(1)} s wall, ${webgl?.[2] ?? "?"} webgl${b.render.ok ? "" : "  FAILED (see out/mass/logs)"}`);
    if (!b.render.ok) throw new Error(`render failed for ${name}`);
  }
}

// ---------------------------------------------------------------- repaint (PAID)
const cost = (frames) => {
  const s = frames / FPS;                                  // what the harness probes from the mp4
  return { video_s: s, reserve: MODELS.recast.estimate(s, RESOLUTION), listed: Math.max(s, 5) * LISTED_USD_PER_S,
    fal_s: s * FAL_S_PER_VIDEO_S + FAL_OVERHEAD_S };
};
/** Greedy pool schedule: wall time for jobs of the given durations at concurrency k. */
const poolWall = (durations, k) => { const w = Array(k).fill(0); for (const d of durations) { w.sort((a, b) => a - b); w[0] += d; } return Math.max(0, ...w); };

function spentSoFar(state) {
  let reserve = 0, listed = 0, calls = 0;
  for (const b of Object.values(state.batches)) for (const a of b.repaint?.attempts ?? []) {
    if (!a.paid_call) continue;
    reserve += a.reserve; listed += a.listed; calls++;
  }
  return { reserve, listed, calls };
}

function plan(state) {
  const basis = opt["budget-basis"] ?? "reserve";
  if (!["reserve", "listed"].includes(basis)) throw new Error("--budget-basis must be reserve or listed");
  const inScope = Object.entries(state.batches).filter(([, b]) => b.min_rank <= TOP).sort(([a], [b]) => a.localeCompare(b));
  const done = inScope.filter(([, b]) => b.repaint?.status === "cut");
  // "running" left over from a crash counts as failed: a paid request may have gone out, so never auto-retry it
  const bad = (b) => ["failed", "frame_mismatch", "cut_failed", "running"].includes(b.repaint?.status);
  const failed = inScope.filter(([, b]) => bad(b));
  const todo = inScope.filter(([, b]) => b.render?.ok && b.repaint?.status !== "cut" && (opt["retry-failed"] || !bad(b)));
  const notRendered = inScope.filter(([, b]) => !b.render?.ok);
  return { basis, inScope, done, failed, todo, notRendered };
}

function projection(state) {
  // Signs in the top N that have no batch yet (not extracted, or extracted but not batched).
  const { ranked } = loadRanked();
  const top = ranked.slice(0, TOP);
  const checked = Object.values(state.signs).filter((s) => s.status === "kept" || s.status === "dropped");
  const keepRate = checked.length ? checked.filter((s) => s.status === "kept").length / checked.length : 0.85;
  const unknown = top.filter((r) => !state.signs[r.gloss] || !["kept", "dropped"].includes(state.signs[r.gloss].status)).length;
  const keptUnbatched = top.filter((r) => state.signs[r.gloss]?.status === "kept" && !state.signs[r.gloss].batch).length;
  const built = Object.values(state.batches);
  const sPerSign = built.length ? built.reduce((a, b) => a + b.frames, 0) / built.reduce((a, b) => a + b.signs.length, 0) / FPS : 2.0;
  const fPerBatch = built.length ? built.reduce((a, b) => a + b.frames, 0) / built.length : 240;
  const signs = unknown * keepRate + keptUnbatched;
  const batches = Math.ceil((signs * sPerSign * FPS) / fPerBatch);
  return { unknown, keptUnbatched, keepRate, sPerSign, fPerBatch, signs: Math.round(signs), batches,
    expectedDrops: Math.round(unknown * (1 - keepRate)) };
}

async function repaint() {
  const state = loadState();
  const k = Math.max(1, Number(opt.concurrency ?? 2));
  const p = plan(state);
  const spent = spentSoFar(state);
  const budget = opt["budget-usd"] == null ? null : Number(opt["budget-usd"]);
  const rows = p.todo.map(([name, b]) => ({ name, b, ...cost(b.frames) }));
  // budget check, in order, on the recorded total + this plan
  let accR = spent.reserve, accL = spent.listed;
  for (const r of rows) {
    const nr = accR + r.reserve, nl = accL + r.listed;
    r.fits = budget == null || ((p.basis === "listed" || nr <= budget + 1e-9) && nl <= budget + 1e-9);
    if (!r.fits) { for (const later of rows.slice(rows.indexOf(r))) later.fits = false; break; }
    accR = nr; accL = nl;
  }
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const run_ = rows.filter((r) => r.fits);
  const proj = projection(state);
  const pc = cost(proj.fPerBatch);
  const projRows = { batches: proj.batches, video_s: proj.batches * pc.video_s, reserve: proj.batches * pc.reserve, listed: proj.batches * pc.listed, fal: Array(proj.batches).fill(pc.fal_s) };
  const tot = {
    batches: rows.length + projRows.batches,
    video_s: sum(rows, (r) => r.video_s) + projRows.video_s,
    reserve: sum(rows, (r) => r.reserve) + projRows.reserve,
    listed: sum(rows, (r) => r.listed) + projRows.listed,
    wall: poolWall([...rows.map((r) => r.fal_s), ...projRows.fal], k),
  };
  const signsBuilt = sum(rows, (r) => r.b.signs.length);
  console.log(`repaint plan: top ${TOP}, H3 Max Recast ${RESOLUTION}, concurrency ${k}${budget != null ? `, budget ${usd(budget)} on ${p.basis}${p.basis === "reserve" ? " (and listed)" : ""}` : ""}`);
  console.log(`  batches in scope: ${p.inScope.length} built (${p.done.length} done, ${p.failed.length} failed, ${p.notRendered.length} not rendered yet, ${rows.length} ready to repaint)`);
  console.log(`  already recorded: ${spent.calls} paid calls, reserve ${usd(spent.reserve)}, listed ${usd(spent.listed)}`);
  if (opt["dry-run"] || opt.verbose) {
    console.log("\n  | batch | signs | frames | video s | reserve | listed | fal time |\n  |---|---|---|---|---|---|---|");
    for (const r of rows) console.log(`  | ${r.name} | ${r.b.signs.length} | ${r.b.frames} | ${r.video_s.toFixed(2)} | ${usd(r.reserve)} | ${usd(r.listed)} | ${hms(r.fal_s)} |${r.fits ? "" : " over budget"}`);
  }
  console.log(`\n  | | batches | signs | video s | reserve (harness) | listed ($${LISTED_USD_PER_S}/s) | wall @ ${k} |\n  |---|---|---|---|---|---|---|`);
  console.log(`  | built, ready | ${rows.length} | ${signsBuilt} | ${sum(rows, (r) => r.video_s).toFixed(1)} | ${usd(sum(rows, (r) => r.reserve))} | ${usd(sum(rows, (r) => r.listed))} | ${hms(poolWall(rows.map((r) => r.fal_s), k))} |`);
  if (proj.batches) console.log(`  | projected, not built yet | ${projRows.batches} | ~${proj.signs} | ${projRows.video_s.toFixed(1)} | ${usd(projRows.reserve)} | ${usd(projRows.listed)} | ${hms(poolWall(projRows.fal, k))} |`);
  console.log(`  | **total** | **${tot.batches}** | **~${signsBuilt + proj.signs}** | **${tot.video_s.toFixed(1)}** | **${usd(tot.reserve)}** | **${usd(tot.listed)}** | **${hms(tot.wall)}** |`);
  if (proj.batches) console.log(`  projection: ${proj.unknown} signs not extracted yet x keep rate ${(proj.keepRate * 100).toFixed(0)}% (~${proj.expectedDrops} drops) + ${proj.keptUnbatched} kept unbatched; ${proj.sPerSign.toFixed(2)} s of video per sign, ${(proj.fPerBatch / FPS).toFixed(2)} s per batch`);
  console.log(`  fal time model: ${FAL_S_PER_VIDEO_S} s per video second + ${FAL_OVERHEAD_S} s per call (measured 10.8-15.6 s/s), greedy schedule over ${k} slots`);
  if (budget != null) console.log(`  within budget now: ${run_.length}/${rows.length} batches, reserve ${usd(sum(run_, (r) => r.reserve))}, listed ${usd(sum(run_, (r) => r.listed))}`);
  if (rows[0]) console.log(`\n  per batch it runs (example):\n  node pipeline/e0.mjs --puppet ${rows[0].b.render.mp4} --source ${rows[0].b.render.mp4} --model recast --resolution ${RESOLUTION} --run-dir ${join(C.runs, rows[0].name)} --execute --authorize-paid E0-PAID --max-usd ${Math.ceil(rows[0].reserve)}\n  then: frame check (generated == ${rows[0].b.frames}) and sign-clips.mjs cut --out-dir ${C.clips}`);

  if (opt["dry-run"]) return;
  if (opt.simulate) {
    // Free: the puppet render stands in for generated.mp4, to test frame check + cut + manifest + aliases.
    if (!opt["clips-dir"]) throw new Error("--simulate needs an explicit --clips-dir (never the real clip set)");
    C.runs = join(C.out, "simulate");
    for (const r of rows.slice(0, Number(opt.limit ?? 2))) await repaintOne(state, r);
    return;
  }
  if (!opt.execute) { console.log("\nnothing spent: add --dry-run to only plan, or --execute --budget-usd X to run the paid step"); return; }
  if (budget == null || !(budget > 0)) throw new Error("--execute needs --budget-usd X (total across all runs recorded in state.json)");
  if (!env.FAL_KEY) throw new Error("--execute needs FAL_KEY in the environment");
  if (!run_.length) { console.log("nothing to do within the budget"); return; }

  let failures = 0, stop = false;
  const queue = [...run_];
  const worker = async () => {
    while (queue.length && !stop) {
      const r = queue.shift();
      await repaintOne(state, r).then((ok) => { failures = ok ? 0 : failures + 1; if (failures >= 2) { stop = true; console.error("two failures in a row: stopping (check the logs before spending more)"); } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(k, queue.length) }, worker));
  const after = spentSoFar(state);
  console.log(`repaint: done. recorded total reserve ${usd(after.reserve)}, listed ${usd(after.listed)} over ${after.calls} calls`);
}

function simulateRun(mp4, runDir) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "generated.mp4"), readFileSync(mp4));
  writeFileSync(join(runDir, "result.json"), JSON.stringify({ status: "generated_unreviewed", simulated: true, paid: null }));
  return { code: 0 };
}

async function repaintOne(state, r) {
  const b = state.batches[r.name];
  b.repaint ??= { attempts: [] };
  const n = b.repaint.attempts.length;
  const runDir = join(C.runs, n ? `${r.name}-try${n + 1}` : r.name);
  const maxUsd = Math.min(30, Math.ceil(r.reserve));
  const attempt = { run_dir: runDir, started: new Date().toISOString(), reserve: r.reserve, listed: r.listed, max_usd: maxUsd, paid_call: true };
  b.repaint.attempts.push(attempt);
  b.repaint.status = "running";
  saveState(state);                                        // record the reserve BEFORE spending
  console.log(`  ${r.name}: repaint (${r.b.signs.length} signs, ${r.video_s.toFixed(2)} s, reserve ${usd(r.reserve)}, --max-usd ${maxUsd})`);
  const { code } = opt.simulate ? simulateRun(b.render.mp4, runDir) : await run(process.execPath, ["pipeline/e0.mjs", "--puppet", b.render.mp4, "--source", b.render.mp4, "--model", "recast",
    "--resolution", RESOLUTION, "--run-dir", runDir, "--execute", "--authorize-paid", "E0-PAID", "--max-usd", String(maxUsd)],
    { log: join(C.out, "logs", `repaint-${basename(runDir)}.log`), quiet: true });
  const result = existsSync(join(runDir, "result.json")) ? load(join(runDir, "result.json")) : null;
  attempt.exit = code;
  attempt.status = result?.status ?? "no_result";
  attempt.request_id = result?.paid?.request_id ?? null;
  attempt.runtime_s = result?.paid?.runtime_seconds ?? null;
  attempt.paid_call = result != null && !opt.simulate;                     // no result.json = the harness guard refused before any upload
  const gen = join(runDir, "generated.mp4");
  if (attempt.status !== "generated_unreviewed" || !existsSync(gen)) {
    b.repaint.status = "failed"; saveState(state);
    console.error(`  ${r.name}: FAILED (${attempt.status}); see ${runDir}/report.md`);
    return false;
  }
  const frames = frameCount(gen);
  attempt.generated_frames = frames;
  if (frames !== b.frames) {
    b.repaint.status = "frame_mismatch"; saveState(state);
    console.error(`  ${r.name}: generated ${frames} frames, expected ${b.frames}; NOT cut (cuts must be frame-exact)`);
    return false;
  }
  const cut = spawnSync(process.execPath, ["pipeline/sign-clips.mjs", "cut", "--video", gen, "--segments", b.segments, "--out-dir", C.clips], { cwd: ROOT, encoding: "utf8" });
  if (cut.status !== 0) { b.repaint.status = "cut_failed"; saveState(state); console.error(cut.stderr); return false; }
  // enrich the manifest: rank/frequency, and aliases (synonyms that share the same WLASL video) -> same clip file
  const mPath = join(C.clips, "manifest.json");
  const manifest = load(mPath);
  for (const g of b.signs) {
    const s = state.signs[g];
    const e = manifest[s.id];
    if (!e) continue;
    Object.assign(e, { source: "wlasl-mass", batch: r.name, rank: s.rank, zipf: s.zipf, flags: s.flags });
    for (const a of s.aliases ?? []) { const id = toId(a); if (!manifest[id]) manifest[id] = { ...e, gloss: a.toUpperCase(), alias_of: s.id }; }
  }
  save(mPath, manifest);
  b.repaint.status = "cut";
  b.repaint.generated = gen;
  saveState(state);
  console.log(`  ${r.name}: ${frames}/${b.frames} frames, cut ${b.signs.length} clips -> ${C.clips}`);
  return true;
}

// ---------------------------------------------------------------- status
function status() {
  const state = loadState();
  const ranked = existsSync(rankedPath) ? load(rankedPath) : null;
  const signs = Object.values(state.signs);
  const inTop = signs.filter((s) => s.rank <= TOP);
  const batches = Object.values(state.batches);
  const reasons = {};
  for (const s of inTop.filter((s) => s.status === "dropped")) { const k = s.reason.split(":")[0].replace(/_[\d.]+%.*/, "_below_80%").replace(/_\d+_frames/, ""); reasons[k] = (reasons[k] ?? 0) + 1; }
  const manifest = existsSync(join(C.clips, "manifest.json")) ? load(join(C.clips, "manifest.json")) : {};
  const spent = spentSoFar(state);
  const out = {
    ranked: ranked?.counts ?? null,
    top: TOP,
    extracted: inTop.length,
    kept: inTop.filter((s) => s.status === "kept").length,
    dropped: inTop.filter((s) => s.status === "dropped").length,
    dropped_by_reason: reasons,
    batched_signs: inTop.filter((s) => s.batch).length,
    batches: batches.length,
    batch_seconds: Number(batches.reduce((a, b) => a + b.frames / FPS, 0).toFixed(1)),
    rendered_batches: batches.filter((b) => b.render?.ok).length,
    repainted_batches: batches.filter((b) => b.repaint?.status === "cut").length,
    failed_batches: batches.filter((b) => ["failed", "frame_mismatch", "cut_failed"].includes(b.repaint?.status)).length,
    clips_in_manifest: Object.keys(manifest).length,
    recorded_spend: { calls: spent.calls, reserve_usd: Number(spent.reserve.toFixed(2)), listed_usd: Number(spent.listed.toFixed(2)) },
  };
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------- main
const commands = {
  rank, extract, batch, render, repaint, status,
  qa: () => { const s = loadState(); const n = qaAll(s, TOP); saveState(s); console.log(`qa: ${n} signs checked`); },
  run: async () => { if (opt.rerank || !existsSync(rankedPath)) rank(); await extract(); await batch(); await render(); status(); },
};
if (!commands[cmd]) {
  console.log(readFileSync(import.meta.filename, "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(cmd === "help" ? 0 : 2);
}
mkdirSync(C.out, { recursive: true });
try { await commands[cmd](); }
catch (e) { console.error(`mass ${cmd}: ${e.message}`); process.exitCode = 1; }
finally { killAll(); }
