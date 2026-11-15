// Generate-on-use: a sign we have MOTION for (MOTION_DIRS) but no realistic clip yet is rendered in the background
// and added to the live clip library, so the next sentence that needs it is signed. The current request is never
// delayed: it gets what the safety gate allows now (captions only) plus `generating: [{motion_id, gloss, eta_s}]`.
//
// One in-process worker, one batch at a time (the same method as the offline vocabulary,
// experiments/2026-11-15-sentences-and-benchmarks.md):
//   gather queued signs (~3 s) -> NEUTRAL S1 NEUTRAL S2 ... NEUTRAL (puppet/compose.mjs, >= 5 s, <= 14 s)
//   -> puppet/render.mjs --view vrm -> H3 Max Recast 768P (pipeline/lib/fal.mjs, safety checker on)
//   -> output frames == input frames -> cutClips into ONDEMAND_CLIPS_DIR (own manifest) -> onClipsAdded (hot reload).
// A failed batch is retried once; after that the sign is marked failed with a reason and stays caption-only.
// Spend: a per-batch reserve of $0.25 per video second (min 5 s) is counted against FAL_DAILY_BUDGET_USD before the
// fal call; a batch that would exceed it is refused. State (queue, spend, batches) persists in ONDEMAND_STATE_DIR/state.json.
// Secrets: the fal key lives only in this process (process.env.FAL_KEY for fal.mjs); child processes never get it, and
// every stored or logged error goes through the server's redactor.

import { spawn, execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { cutClips, cutPoints } from "../../../pipeline/lib/clips.mjs";
import { MODELS } from "../../../pipeline/e0/models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../../..");
export const USD_PER_VIDEO_S = 0.25;   // H3 Max ~$0.085/s + input tokens ~= $0.22/s of video; rounded up to be safe
export const MIN_BATCH_S = 5;          // H3 Max Recast minimum
export const MAX_BATCH_S = 14;         // single shot must be <= 15 s
const FPS = 24;
const NEUTRAL_S = 13 / FPS;            // out/realtime/neutral.clean.json is 13 frames
const MIN_PURE_NEUTRAL = 3;            // still frames at every cut (make-batches.mjs --min-pure)
const MAX_ATTEMPTS = 2;                // first try + one retry
const CANONICAL = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const ACTIVE = new Set(["queued", "running"]);

class OnDemandError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const list = (v) => String(v ?? "").split(/[,;]/).map((d) => d.trim()).filter(Boolean);
const firstExisting = (paths) => paths.find((p) => p && existsSync(p));
const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const round2 = (x) => Math.round(x * 100) / 100;
export const reserveUsd = (videoS) => round2(Math.max(videoS, MIN_BATCH_S) * USD_PER_VIDEO_S);

/**
 * Settings from the environment. Enabled only with ONDEMAND=on, a fal key and at least one motion dir.
 * @returns {{wanted: boolean, enabled: boolean, reason?: string, ...options}}
 */
export function onDemandConfig(env = process.env, { falKey = null, keyError } = {}) {
  const wanted = env.ONDEMAND !== undefined && env.ONDEMAND !== "";
  const on = /^(on|1|true|yes)$/i.test(env.ONDEMAND ?? "");
  const motionDirs = list(env.MOTION_DIRS);
  const cfg = {
    wanted,
    motionDirs,
    neutral: env.ONDEMAND_NEUTRAL || firstExisting([join(REPO, "out/realtime/neutral.clean.json"),
      resolve(REPO, "../sign-avatar-b-puppet/out/realtime/neutral.clean.json")]) || join(REPO, "out/realtime/neutral.clean.json"),
    avatar: env.ONDEMAND_AVATAR || join(REPO, "assets/avatar/avatar-main.jpg"),
    renderScript: env.PUPPET_RENDER || join(REPO, "puppet/render.mjs"),
    stateDir: env.ONDEMAND_STATE_DIR || join(REPO, "out/ondemand"),
    clipsDir: env.ONDEMAND_CLIPS_DIR || join(REPO, "out/realtime/clips-ondemand"),
    budgetUsd: Number(env.FAL_DAILY_BUDGET_USD) >= 0 && env.FAL_DAILY_BUDGET_USD !== undefined && env.FAL_DAILY_BUDGET_USD !== "" ? Number(env.FAL_DAILY_BUDGET_USD) : 20,
    maxQueue: Number(env.ONDEMAND_MAX_QUEUE) > 0 ? Math.floor(Number(env.ONDEMAND_MAX_QUEUE)) : 30,
    minHandPct: Number.isFinite(Number(env.ONDEMAND_MIN_HAND_PCT)) && env.ONDEMAND_MIN_HAND_PCT ? Number(env.ONDEMAND_MIN_HAND_PCT) : 80,
    falKey,
  };
  const reason = !on ? (wanted ? `ONDEMAND=${env.ONDEMAND} (set ONDEMAND=on)` : "ONDEMAND is not on")
    : !falKey ? (keyError ?? "no fal key (set FAL_KEY_FILE or FAL_KEY)")
    : !motionDirs.length ? "MOTION_DIRS is not set"
    : null;
  return { ...cfg, enabled: !reason, ...(reason ? { reason } : {}) };
}

// ── Motion index ────────────────────────────────────────────────────────────────

/** summary.csv from motion/batch_library.py: name -> {error, pct, seconds}. Missing file = no QC info. */
function readSummary(dir) {
  const out = new Map();
  const p = join(dir, "summary.csv");
  if (!existsSync(p)) return out;
  const [head, ...lines] = readFileSync(p, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  for (const line of lines) {
    const row = Object.fromEntries(line.split(",").map((v, k) => [cols[k], v]));
    if (!row.name) continue;
    const frames = Number(row.trimmed_frames), fps = Number(row.fps);
    out.set(row.name, { error: row.error || "", pct: row.dominant_hand_pct_clean === "" ? NaN : Number(row.dominant_hand_pct_clean),
      seconds: frames > 0 && fps > 0 ? frames / fps : null });
  }
  return out;
}

/** motion_id / gloss / fps from the first 4 KB of a motion file (they come before the frames). */
function readHead(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const s = buf.subarray(0, n).toString("utf8");
    return { motion_id: /"motion_id"\s*:\s*"([^"]+)"/.exec(s)?.[1] ?? null, gloss: /"gloss"\s*:\s*"([^"]+)"/.exec(s)?.[1] ?? null };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

export const displayGloss = (g) => String(g).replace(/_/g, " ").replace(/\s+/g, " ").trim().toUpperCase();

/**
 * Signs with extracted motion: motion_id -> {motion_id, gloss, path, seconds}. Signs that failed extraction or QC
 * (summary.csv error, dominant hand detected in < minHandPct % of frames) are left out. First dir / file wins.
 */
export function scanMotionDirs(dirs, { minHandPct = 80, heads = new Map() } = {}) {
  const index = new Map();
  for (const dir of dirs) {
    let files;
    try { files = readdirSync(dir).filter((f) => f.endsWith(".clean.json")).sort(); } catch { continue; }
    const qc = readSummary(dir);
    for (const f of files) {
      const name = f.slice(0, -".clean.json".length);
      const row = qc.get(name);
      if (row && (row.error || (Number.isFinite(row.pct) && row.pct < minHandPct))) continue;
      const path = join(dir, f);
      let head = heads.get(path);
      if (!head) { head = readHead(path); if (head?.motion_id) heads.set(path, head); }
      const id = head?.motion_id;
      if (!id || !CANONICAL.test(id) || /^FS_/.test(id) || !head.gloss || index.has(id)) continue;
      index.set(id, { motion_id: id, gloss: displayGloss(head.gloss), path, seconds: row?.seconds ?? null });
    }
  }
  return index;
}

// ── Real pipeline steps (tests inject fakes) ────────────────────────────────────

/** Environment for child processes: never the fal or OpenAI key. */
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(FAL_KEY|OPENAI_API_KEY)/i.test(k)));
}

function runChild(cmd, args, { cwd, timeoutMs, children, tail = 2000 }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    let out = "", err = "";
    child.stdout.on("data", (d) => { out = (out + d).slice(-64_000); });
    child.stderr.on("data", (d) => { err = (err + d).slice(-tail); });
    const timer = setTimeout(() => { killTree(child); reject(new OnDemandError("timeout", `${args[args.length - 1]}: timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); children.delete(child); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer); children.delete(child);
      if (code === 0) resolveRun({ stdout: out, stderr: err });
      else reject(new OnDemandError("child_failed", `exit ${code}: ${(err || out).trim().split(/\r?\n/).slice(-3).join(" | ")}`));
    });
  });
}

/** Kill a child and everything it started (render.mjs starts Chrome). */
export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
}

export function realSteps({ renderScript, children, log }) {
  const composeScript = join(REPO, "puppet/compose.mjs");
  let avatarCache = null;
  return {
    /** NEUTRAL S1 NEUTRAL ... NEUTRAL, padded with a neutral hold to >= minSeconds. -> {frames, seconds, segments} */
    async compose({ neutral, signs, out, minSeconds }) {
      const inputs = [neutral, ...signs.flatMap((s) => [s.path, neutral])];
      const { stdout } = await runChild(process.execPath, ["--experimental-strip-types", "--no-warnings", composeScript,
        "--out", out, "--min-seconds", String(minSeconds), ...inputs], { cwd: REPO, timeoutMs: 180_000, children });
      const line = stdout.trim().split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
      if (!line) throw new OnDemandError("compose_failed", "compose.mjs printed no result");
      return JSON.parse(line);
    },
    /** puppet/render.mjs --view vrm (headless Chrome, CPU). */
    async render({ motion, out }) {
      if (!existsSync(renderScript)) throw new OnDemandError("no_renderer", `renderer not found: ${renderScript} (set PUPPET_RENDER)`);
      await runChild(process.execPath, [renderScript, "--motion", motion, "--view", "vrm", "--out", out],
        { cwd: dirname(dirname(renderScript)), timeoutMs: 30 * 60_000, children });
    },
    async probeFrames(file) {
      const { stdout } = await promisify(execFile)("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { windowsHide: true, env: childEnv() });
      const n = Number(stdout.trim());
      if (!Number.isInteger(n) || n < 1) throw new OnDemandError("probe_failed", `cannot count frames of ${file}`);
      return n;
    },
    /** One H3 Max Recast call through pipeline/lib/fal.mjs (same input shape as pipeline/e0/models.mjs). */
    async recast({ video, avatar, out, resolution }) {
      if (!process.env.FAL_KEY) throw new OnDemandError("no_key", "fal key not loaded");   // fal.mjs would exit the process
      const { toUrl, run, download } = await import(pathToFileURL(join(REPO, "pipeline/lib/fal.mjs")).href);
      const model = MODELS.recast;
      const videoUrl = await toUrl(video);
      avatarCache ??= { path: avatar, url: await toUrl(avatar) };
      const avatarUrl = avatarCache.path === avatar ? avatarCache.url : await toUrl(avatar);
      const input = model.input({ videoUrl, avatarUrl, resolution });
      const result = await withTimeout(run(model.endpoint, input), 20 * 60_000, "fal call");
      const url = result.data?.video?.url;
      if (!url) throw new OnDemandError("no_video", "Recast returned no video URL");
      await download(url, out);
      log?.(`ondemand: recast ${result.requestId} done in ${result.seconds} s`);
      return { request_id: result.requestId, fal_s: result.seconds, seed: result.data?.seed ?? null };
    },
    cut: (o) => cutClips(o),
  };
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new OnDemandError("timeout", `${what} timed out after ${Math.round(ms / 1000)} s`)), ms).unref?.())]);

// ── The queue + worker ──────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {boolean} o.enabled
 * @param {string[]} o.motionDirs
 * @param {string} o.neutral         neutral.clean.json
 * @param {string} o.avatar          reference image for Recast
 * @param {string} o.stateDir        state.json + batches/<id>/ work files
 * @param {string} o.clipsDir        where generated clips + manifest.json go
 * @param {number} o.budgetUsd       daily reserve cap
 * @param {number} o.maxQueue
 * @param {(id: string) => boolean} o.hasClip      true if the live library already has a clip for this motion_id
 * @param {(ids: string[]) => void|Promise<void>} o.onClipsAdded   hot reload hook
 * @param {(s: string) => string} [o.redact]
 * @param {(line: string) => void} [o.log]
 * @param {object} [o.steps]         {compose, render, probeFrames, recast, cut} overrides (tests)
 * @param {number} [o.gatherMs]      how long to wait for more signs before starting a batch (default 3000)
 * @param {() => number} [o.now]
 */
export function createOnDemand(o) {
  if (!o.enabled) return disabled(o.reason ?? "off");
  const log = (line) => (o.log ?? (() => {}))(redact(line));
  const redact = o.redact ?? ((s) => String(s));
  const now = o.now ?? (() => Date.now());
  const gatherMs = o.gatherMs ?? 3000;
  const minHandPct = o.minHandPct ?? 80;
  const children = new Set();
  const steps = { ...realSteps({ renderScript: o.renderScript ?? join(REPO, "puppet/render.mjs"), children, log }), ...(o.steps ?? {}) };
  const statePath = join(o.stateDir, "state.json");
  const heads = new Map();
  let index = new Map(), scannedAt = 0, version = 0;
  let busy = false, stopped = false, current = null, idleWaiters = [];


  mkdirSync(o.stateDir, { recursive: true });
  prepareClipsDir(o.clipsDir);

  const state = loadState();
  rescan(true);
  log(`ondemand: on, ${index.size} signs with motion, budget $${o.budgetUsd}/day, max queue ${o.maxQueue}, clips -> ${o.clipsDir}`);
  setTimeout(() => { if (queued().length) kick(); }, 0);   // resume a queue left by the last run

  function loadState() {
    let s = null;
    try { s = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
    if (!s || typeof s !== "object" || !s.items) s = { version: 1, day: localDay(now()), spent_today_usd: 0, done_today: 0, spent_total_usd: 0, items: {}, batches: [], rate: null };
    // A batch that was running when the server stopped: try again if it has an attempt left.
    for (const it of Object.values(s.items)) {
      if (it.status !== "running") continue;
      if (it.attempts < MAX_ATTEMPTS) it.status = "queued";
      else Object.assign(it, { status: "failed", code: "interrupted", reason: "server stopped during the batch", finished_at: now() });
    }
    return s;
  }
  function save() {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1));
    renameSync(tmp, statePath);
  }
  function rollDay() {
    const day = localDay(now());
    if (state.day !== day) { state.day = day; state.spent_today_usd = 0; state.done_today = 0; }
  }
  /** Re-read MOTION_DIRS at most once a minute (another job keeps adding motion). */
  function rescan(force = false) {
    if (!force && now() - scannedAt < 60_000) return;
    scannedAt = now();
    const next = scanMotionDirs(o.motionDirs, { minHandPct, heads });
    if (next.size !== index.size || [...next.keys()].some((k) => !index.has(k))) version++;
    index = next;
  }
  const queued = () => Object.values(state.items).filter((it) => it.status === "queued").sort((a, b) => a.enqueued_at - b.enqueued_at);
  const running = () => Object.values(state.items).filter((it) => it.status === "running");
  const budgetLeft = () => o.budgetUsd - state.spent_today_usd;
  const signSeconds = (id) => (index.get(id)?.seconds ?? 1.6);
  const batchSeconds = (ids) => Math.max(MIN_BATCH_S, NEUTRAL_S + ids.reduce((s, id) => s + signSeconds(id) + NEUTRAL_S, 0));
  // Wall time of a batch: render (~0.45 s per frame on CPU) + Recast (~15 s per video second) + upload/cut overhead.
  const batchWallS = (videoS) => Math.round((state.rate?.overhead_s ?? 30) + videoS * (state.rate?.s_per_video_s ?? 26));

  function eta(it) {
    const t = now();
    let ahead = 0;
    if (current) ahead = Math.max(10, current.est_wall_s - (t - current.started_at) / 1000);
    if (it.status === "running") return Math.round(ahead);
    const q = queued().map((x) => x.motion_id);
    const pos = q.indexOf(it.motion_id);
    // queued signs ahead of this one go in the same or earlier batches
    const upTo = q.slice(0, pos + 1);
    let batches = 0, cur = [];
    for (const id of upTo) { if (cur.length && batchSeconds([...cur, id]) > MAX_BATCH_S) { batches++; cur = [id]; } else cur.push(id); }
    const gather = Math.max(0, (it.enqueued_at + gatherMs - t) / 1000);
    return Math.round(ahead + gather + batches * batchWallS(MAX_BATCH_S - 2) + batchWallS(batchSeconds(cur)));
  }
  const view = (it) => ({ motion_id: it.motion_id, gloss: it.gloss, eta_s: eta(it) });

  /**
   * Signs a request wanted but has no clip for. Returns the ones being generated (queued or running).
   * @param {{motion_id: string}[]} wanted
   */
  function request(wanted) {
    if (stopped) return [];
    rollDay();
    rescan();
    const out = [];
    let changed = false;
    for (const id of [...new Set(wanted.map((w) => w?.motion_id).filter(Boolean))]) {
      const m = index.get(id);
      if (!m || o.hasClip(id)) continue;
      const it = state.items[id];
      if (it && ACTIVE.has(it.status)) { out.push(it); continue; }
      if (it && it.status === "failed" && it.code !== "daily_budget") continue;     // gave up after the retry: caption only
      if (queued().length >= o.maxQueue) { log(`ondemand: queue full (${o.maxQueue}); ${id} not queued`); continue; }
      if (budgetLeft() < reserveUsd(MIN_BATCH_S)) continue;                           // nothing could run today
      state.items[id] = { motion_id: id, gloss: m.gloss, status: "queued", attempts: 0, enqueued_at: now() };
      out.push(state.items[id]);
      changed = true;
      log(`ondemand: queued ${id}`);
    }
    if (changed) { save(); kick(); }
    return out.map(view);
  }

  function kick() {
    if (busy || stopped) return;
    busy = true;
    pump().catch((e) => log(`ondemand: worker error: ${e?.message ?? e}`)).finally(() => {
      busy = false;
      if (!stopped && queued().length) setTimeout(kick, 0);
      else { const w = idleWaiters; idleWaiters = []; w.forEach((f) => f()); }
    });
  }

  async function pump() {
    while (!stopped && queued().length) {
      // Gather: wait until the oldest queued sign has waited gatherMs, so signs from one sentence share a batch.
      const wait = queued()[0].enqueued_at + gatherMs - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (stopped) return;
      await runBatch();
    }
  }

  async function runBatch() {
    rollDay();
    const fail = (it, code, reason) => Object.assign(it, { status: "failed", code, reason: redact(reason), finished_at: now() });
    // Pick queued signs in order; drop ones that got a clip meanwhile or whose motion file is not readable.
    const picks = [];
    for (const it of queued()) {
      if (o.hasClip(it.motion_id)) { Object.assign(it, { status: "done", finished_at: now(), code: "already_available" }); continue; }
      const m = index.get(it.motion_id);
      let frames = 0;
      try { frames = m ? JSON.parse(readFileSync(m.path, "utf8")).frames?.length ?? 0 : 0; } catch {}
      if (!m || frames < 2) { fail(it, "bad_motion", m ? `motion file unreadable or empty: ${m.path}` : "motion no longer available"); continue; }
      if (picks.length && batchSeconds([...picks.map((p) => p.motion_id), it.motion_id]) > MAX_BATCH_S) continue;
      picks.push(it);
    }
    if (!picks.length) { save(); return; }

    const id = `od-${new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = join(o.stateDir, "batches", id);
    const ids = picks.map((p) => p.motion_id);
    const batch = { id, signs: ids, status: "running", queued_at: Math.min(...picks.map((p) => p.enqueued_at)), started_at: now(), timings_s: {} };
    const estS = batchSeconds(ids);
    batch.est_seconds = round2(estS);
    batch.est_usd = reserveUsd(estS);
    if (batch.est_usd > budgetLeft()) {
      picks.forEach((p) => fail(p, "daily_budget", `batch reserve $${batch.est_usd} would exceed the daily budget ($${round2(state.spent_today_usd)} of $${o.budgetUsd} used)`));
      Object.assign(batch, { status: "refused", code: "daily_budget", finished_at: now() });
      state.batches.push(batch);
      log(`ondemand: refused batch ${ids.join(" ")}: daily budget`);
      return save();
    }
    picks.forEach((p) => Object.assign(p, { status: "running", attempts: p.attempts + 1, started_at: now(), batch: id }));
    current = { id, started_at: now(), est_wall_s: batchWallS(estS) };
    save();
    log(`ondemand: batch ${id}: ${ids.join(" ")} (~${batch.est_seconds} s video, reserve $${batch.est_usd})`);
    const mark = (k, t0) => { batch.timings_s[k] = round2((now() - t0) / 1000); return now(); };
    let t = now();
    try {
      mkdirSync(dir, { recursive: true });
      const motion = join(dir, `${id}.clean.json`), puppet = join(dir, `${id}-vrm.mp4`), generated = join(dir, "generated.mp4");
      const composed = await steps.compose({ neutral: o.neutral, signs: picks.map((p) => ({ motion_id: p.motion_id, path: index.get(p.motion_id).path })), out: motion, minSeconds: MIN_BATCH_S });
      const seconds = composed.frames / FPS;
      if (seconds > MAX_BATCH_S + 1) throw new OnDemandError("too_long", `batch is ${seconds.toFixed(2)} s (> ${MAX_BATCH_S} s)`);
      checkPureNeutral(composed.segments);
      cutPoints(composed.segments);
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ ...composed, signs: ids }));
      Object.assign(batch, { frames: composed.frames, seconds: round2(seconds) });
      t = mark("compose", t);

      await steps.render({ motion, out: puppet });
      const rendered = await steps.probeFrames(puppet);
      if (rendered !== composed.frames) throw new OnDemandError("frames_mismatch", `puppet render has ${rendered} frames, motion has ${composed.frames}`);
      t = mark("render", t);

      // Commit the reserve before the paid call (exact length now known); refuse if it no longer fits.
      const reserve = reserveUsd(seconds);
      if (reserve > budgetLeft()) throw new OnDemandError("daily_budget", `batch reserve $${reserve} would exceed the daily budget ($${round2(state.spent_today_usd)} of $${o.budgetUsd} used)`);
      batch.reserve_usd = reserve;
      state.spent_today_usd = round2(state.spent_today_usd + reserve);
      state.spent_total_usd = round2((state.spent_total_usd ?? 0) + reserve);
      save();
      const r = await steps.recast({ video: puppet, avatar: o.avatar, out: generated, resolution: "768P" });
      Object.assign(batch, { request_id: r?.request_id ?? null, fal_s: r?.fal_s ?? null });
      t = mark("fal", t);

      const got = await steps.probeFrames(generated);
      if (got !== composed.frames) throw new OnDemandError("frames_mismatch", `generated video has ${got} frames, expected ${composed.frames}; not cutting (timing must be frame-exact)`);
      await steps.cut({ video: generated, segments: composed.segments, outDir: o.clipsDir,
        signs: picks.map((p) => ({ id: p.motion_id, gloss: p.gloss })), extra: { ondemand_batch: id } });
      t = mark("cut", t);

      await o.onClipsAdded(ids);
      mark("reload", t);
      const total = (now() - batch.queued_at) / 1000;
      Object.assign(batch, { status: "done", finished_at: now(), total_s: round2(total) });
      picks.forEach((p) => Object.assign(p, { status: "done", finished_at: now(), code: undefined, reason: undefined }));
      state.done_today += picks.length;
      // Learn the wall-time rate for ETAs (render + fal per video second).
      const work = (batch.timings_s.render ?? 0) + (batch.timings_s.fal ?? 0);
      if (seconds > 0 && work > 0) state.rate = { s_per_video_s: round2(work / seconds), overhead_s: round2(Math.max(10, total - work)) };
      log(`ondemand: batch ${id} done: ${ids.join(" ")} available (${batch.total_s} s from queue)`);
    } catch (error) {
      const code = error?.code && typeof error.code === "string" ? error.code : "failed";
      const reason = redact(error instanceof Error ? error.message : String(error));
      Object.assign(batch, { status: "failed", code, reason, finished_at: now() });
      for (const p of picks) {
        if (code !== "daily_budget" && p.attempts < MAX_ATTEMPTS) Object.assign(p, { status: "queued", code, reason, enqueued_at: now() - gatherMs });
        else fail(p, code, reason);
      }
      log(`ondemand: batch ${id} failed (${code}): ${reason}`);
    } finally {
      current = null;
      state.batches.push(batch);
      if (state.batches.length > 50) state.batches.splice(0, state.batches.length - 50);
      save();
    }
  }

  function health() {
    rollDay();
    return { enabled: true, queued: queued().length, running: running().length, done_today: state.done_today, spent_today_est: round2(state.spent_today_usd) };
  }

  return {
    enabled: true,
    clipsDir: o.clipsDir,
    /** Changes whenever the set of signs with motion changes. */
    get version() { return version; },
    has: (id) => index.has(id),
    /** Signs with motion (for planning which words could be generated). */
    motionVocab: () => [...index.values()].map(({ motion_id, gloss }) => ({ motion_id, gloss })),
    rescan,
    request,
    health,
    status: () => ({ ...health(), budget_usd: o.budgetUsd, max_queue: o.maxQueue, motion_signs: index.size, day: state.day,
      spent_total_est: round2(state.spent_total_usd ?? 0), rate: state.rate ?? null, clips_dir: o.clipsDir,
      items: Object.values(state.items).sort((a, b) => b.enqueued_at - a.enqueued_at).slice(0, 100)
        .map((it) => ({ ...it, ...(ACTIVE.has(it.status) ? { eta_s: eta(it) } : {}) })),
      batches: state.batches.slice(-10).reverse() }),
    /** Resolves when the worker has nothing left to do (tests, shutdown). */
    idle: () => (busy || queued().length ? new Promise((r) => { idleWaiters.push(r); kick(); }) : Promise.resolve()),
    stop() { stopped = true; for (const c of children) killTree(c); children.clear(); const w = idleWaiters; idleWaiters = []; w.forEach((f) => f()); },
  };
}

function checkPureNeutral(segments) {
  const pure = segments.map((s, i) => {
    if (s.gloss) return null;
    const a = i > 0 ? segments[i - 1].end + 1 : s.start;
    const b = i < segments.length - 1 ? segments[i + 1].start - 1 : s.end;
    return b - a + 1;
  }).filter((x) => x !== null).slice(1, -1);
  if (pure.some((n) => n < MIN_PURE_NEUTRAL)) throw new OnDemandError("bad_batch", `only ${Math.min(...pure)} still neutral frames between signs (< ${MIN_PURE_NEUTRAL})`);
}

function disabled(reason) {
  const h = { enabled: false, queued: 0, running: 0, done_today: 0, spent_today_est: 0 };
  return { enabled: false, reason, version: 0, has: () => false, motionVocab: () => [], rescan() {}, request: () => [],
    health: () => h, status: () => ({ ...h, reason }), idle: () => Promise.resolve(), stop() {} };
}

/** The generated-clips dir with an (empty) manifest, so the clip loader can read it before the first batch. */
export function prepareClipsDir(dir) {
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) writeFileSync(manifestPath, "{}\n");
}
