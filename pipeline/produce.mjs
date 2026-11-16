#!/usr/bin/env node
// Production clip factory: sign motions -> photoreal per-sign clips (+ manifest the server reads) for Flux.
//
//   node pipeline/produce.mjs --set demo                                  # dry run (default): batches, seconds, exact cost
//   node pipeline/produce.mjs --set sentences --file pipeline/produce/demo-sentences.txt
//   node pipeline/produce.mjs --set library [--glosses all|LIST|FILE] [--top N]     # whole dictionary by default
//   ... --execute --authorize-paid PROD-PAID --max-usd 60      # paid: FAL_KEY (or FAL_KEY_FILE) in the environment
//   ... --execute --stop-after render                         # Modal renders + render QC only, no fal call
//
// Sets (pipeline/produce/lib.mjs SETS):
//   demo       the 20 demo signs, half speed (compose 48 fps, render 24 fps, cut every 2nd frame), N takes per batch
//              with different seeds (--takes, default 1 for now; 2+ = best of N), every take scored per sign (finger
//              metric), best take per sign kept
//   sentences  one continuous take per sentence (translate/ rules -> NEUTRAL S1 NEUTRAL S2 ... NEUTRAL), half speed;
//              keeps the whole sentence video (sentences/<id>.mp4) and cuts per-sign clips
//   library    the dictionary (index.json), most frequent words first, normal speed, 1 take, batches of ~10 s
// Flow per batch: compose (neutral rest between signs, frame-exact segments) -> render on Modal with the chosen
// renderer commit (--avatar signer, --placement ik, rgb) -> frame count check -> render QC gate (bad frames / palm
// flips: failing signs are dropped and the rest re-packed, never paid for; out/produce/<variant>/qc.json) -> repaint
// on fal (--model, avatar image) -> output frame count check (reject on mismatch) -> finger score -> cut -> even
// colour/zoom per job (even-clips.mjs) -> out/realtime/clips-v2-<variant>/ (manifest.json; the server picks
// clips-v2-demo, -sentences, -library up first, see app/server/lib/clips.mjs).
//
// Money: the dry run is the default and touches nothing paid. Paid needs --execute --authorize-paid PROD-PAID and
// --max-usd N, a hard cap on what THIS run commits, checked before every fal call (cost from pipeline/race/models.mjs).
// Resumable: out/produce/<variant>/state.json; a request id is saved right after submit, a crash resumes by polling it,
// and a batch with a paid take is never re-planned or paid again. requests.log has every request id and its cost.
// Laptop: compose, plan and fal polling only. Rendering, takes download, finger scoring, cutting and evening run on
// Modal (pipeline/produce/modal_render_prod.py, modal_post.py; volume signlayer-renders).
//
// Options:
//   --model recast1080|recast768|ltx_r2r   repaint model (default recast1080, the race winner)
//   --prompt TEXT  --seed N                 prompt (LTX default from race/models.mjs; Recast none) and base seed (4242)
//   --ltx-image                             also send the avatar image to ltx_r2r (default: prompt only)
//   --avatar-model signer|signer-bob        render avatar (/models/<name>.glb on the volume; --avatar-glb FILE uploads it)
//   --avatar-image FILE                     Recast reference photo (default assets/avatar/avatar-main.jpg)
//   --renderer-repo DIR --renderer-ref REF  renderer code (default: the main checkout, ref finals/integration, which has
//                                           the hand-placement fix); any clone + branch/sha works; exported with
//                                           git archive (committed code only), and Modal renders exactly that sha
//   --placement ik|fk|auto                  hand placement (default ik)
//   --takes N  --max-seconds S              takes per batch; batch length in video seconds
//   --concurrency N (10) --chunk N (40)     fal results polled in parallel; batches per round (all of a round's takes
//                                           are submitted up front, 429 / concurrency limits are retried with backoff)
//   --qc-bad-pct P (3) --qc-loc X|off --qc-arm-deg D|off   render QC: hand/palm 60, fingers 50 deg; hand location error
//                                           > 0.6 shoulder widths (ik); arm angle 45 deg only with --placement fk
//   --no-qc  --retry-qc  --redo-upgraded    skip motion QC / retry render-QC rejects / remake v1 signs that now have v2
//   --no-score  --fake-recast               skip the finger score / use the puppet render as the "take" (free test,
//                                           writes out/produce/<variant>-fake/clips, never a served folder)
//   --resubmit-unknown                      resubmit a take whose submit started but never returned a request id
//   --main DIR                              the checkout with out/ (default: this repo, else $SBP_MAIN, else origin)
//   --rows N  --json                        dry-run table rows to print / machine-readable plan

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.execArgv.some((a) => a.includes("strip-types"))) {
  // blend.ts is imported directly: re-run with type stripping (Node 22.6+).
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const lib = await import("./produce/lib.mjs");
const planMod = await import("./produce/plan.mjs");
const {
  REPO, PAID_TOKEN, SETS, DEMO_GLOSSES, RENDER_QC, getModel, variantName, findMain, defaultPaths, outDirFor, motionLibrary, metaCache,
  dictionaryGlosses, parseGlossList, parseSentences, loadState, saveState, batchIsPaid, paidTakes, doneTakes, guardSpend, budgetPrefix,
  renderQc, pickBest, bestPerSign, cutPoints, modelInput, round, toId, displayGloss,
} = lib;
const { planSet, costTable, remainingCost, writeBatch } = planMod;

// ── Arguments ───────────────────────────────────────────────────────────────────
const BOOL = new Set(["execute", "fake-recast", "no-score", "no-qc", "retry-qc", "redo-upgraded", "resubmit-unknown", "json", "ltx-image", "help"]);
const opt = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
  const k = a.slice(2);
  if (BOOL.has(k)) opt[k] = true;
  else { if (argv[i + 1] === undefined) throw new Error(`missing value for ${a}`); opt[k] = argv[++i]; }
}
if (opt.help || !SETS[opt.set]) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(opt.help ? 0 : 2);
}
const SET = opt.set;
const MODEL = getModel(opt.model ?? "recast1080");
const AVATAR_MODEL = opt["avatar-model"] ?? "signer";
const FAKE = Boolean(opt["fake-recast"]);
const VARIANT = variantName(SET, MODEL.name, AVATAR_MODEL) + (FAKE ? "-fake" : "");
const PLACEMENT = opt.placement ?? "ik";
const CONCURRENCY = Math.max(1, Number(opt.concurrency ?? 10));
const CHUNK = Math.max(1, Number(opt.chunk ?? 40));
const DO_SCORE = !opt["no-score"] && SETS[SET].score;
const QC_T = lib.renderQcFor(PLACEMENT, { maxBadPct: opt["qc-bad-pct"] === undefined ? undefined : Number(opt["qc-bad-pct"]),
  armDeg: opt["qc-arm-deg"] === undefined ? undefined : opt["qc-arm-deg"] === "off" ? null : Number(opt["qc-arm-deg"]),
  locMax: opt["qc-loc"] === undefined ? undefined : opt["qc-loc"] === "off" ? null : Number(opt["qc-loc"]) });

const gitOrigin = () => { try { return execFileSync("git", ["-C", REPO, "remote", "get-url", "origin"]).toString().trim(); } catch { return null; } };
const MAIN = findMain(opt.main, { originUrl: gitOrigin() });
const P = defaultPaths(MAIN);
const WORK = join(P.workRoot, VARIANT);
const STATE_PATH = join(WORK, "state.json");
const OUT_DIR = FAKE ? join(WORK, "clips") : outDirFor(P.realtime, VARIANT);
const VOL = `/produce/${VARIANT}`;
// Renderer: committed code of finals/integration in the main checkout (the hand-placement fix is merged there).
const RENDERER_REPO = resolve(opt["renderer-repo"] ?? process.env.PRODUCE_RENDERER_REPO ?? MAIN);
const RENDERER_REF = opt["renderer-ref"] ?? process.env.PRODUCE_RENDERER_REF ?? "finals/integration";
const AVATAR_IMAGE = resolve(opt["avatar-image"] ?? join(REPO, "assets/avatar/avatar-main.jpg"));

// ── Plan ────────────────────────────────────────────────────────────────────────
const meta = metaCache(join(P.workRoot, "motion-meta.json"));
const motions = motionLibrary({ index: P.index, v2Root: P.v2Root, cleanDir: P.cleanDir, massState: join(MAIN, "out/mass/state.json"), meta, qc: !opt["no-qc"] });
const indexJson = JSON.parse(readFileSync(P.index, "utf8"));

function glossItems() {
  if (SET === "demo") return opt.glosses ? parseGlossList(opt.glosses) : DEMO_GLOSSES;
  const spec = opt.glosses ?? "all";
  let items;
  if (spec === "all") items = dictionaryGlosses(indexJson, JSON.parse(readFileSync(join(REPO, "pipeline/produce/zipf.json"), "utf8")));
  else items = parseGlossList(spec).map((g) => ({ gloss: g, aliases: [] }));
  return opt.top ? items.slice(0, Number(opt.top)) : items;
}
let translateRules = null;
if (SET === "sentences") ({ translateRules } = await import("../translate/index.mjs"));
const SENTENCES = SET === "sentences" ? parseSentences(readFileSync(resolve(opt.file ?? join(REPO, "pipeline/produce/demo-sentences.txt")), "utf8")) : null;

const state = loadState(STATE_PATH, VARIANT);
const plan = (extra = {}) => planSet({ set: SET, model: MODEL.name, glosses: SET === "sentences" ? null : glossItems(), sentences: SENTENCES,
  translate: translateRules, lib: motions, neutralPath: P.neutral, state, takes: opt.takes, seedBase: opt.seed, maxVideoS: opt["max-seconds"],
  redoUpgraded: opt["redo-upgraded"], retryQc: opt["retry-qc"], verify: 2, ...extra });

const p0 = plan();
meta.save();
const table = costTable(p0);
const money = (x) => `$${Number(x).toFixed(2)}`;

if (!opt.execute) {
  printDryRun(p0, table);
  process.exit(0);
}

// ── Paid / Modal run ───────────────────────────────────────────────────────────
const STOP = opt["stop-after"] ?? null;          // render | recast | score
if (STOP && !["render", "recast", "score"].includes(STOP)) throw new Error("--stop-after render|recast|score");
const PAID_RUN = !FAKE && STOP !== "render";
const MAX_USD = PAID_RUN ? Number(opt["max-usd"]) : Infinity;
if (PAID_RUN) {
  if (opt["authorize-paid"] !== PAID_TOKEN) throw new Error(`paid run needs --authorize-paid ${PAID_TOKEN} (and --max-usd N); add --stop-after render for a render-only run`);
  if (!(MAX_USD > 0)) throw new Error("--max-usd must be a positive number");
}
if (MODEL.avatarImage && !existsSync(AVATAR_IMAGE)) throw new Error(`avatar image not found: ${AVATAR_IMAGE}`);
mkdirSync(WORK, { recursive: true });
const { exportRenderer, supportsPlacement } = await import("./produce/renderer.mjs");
const renderer = exportRenderer({ repo: RENDERER_REPO, ref: RENDERER_REF, root: join(P.workRoot, "renderers") });
if (PLACEMENT !== "auto" && !supportsPlacement(RENDERER_REPO, renderer.sha)) throw new Error(`renderer ${RENDERER_REF} (${renderer.sha.slice(0, 12)}) has no --placement; point --renderer-ref at the hand-placement fix`);
const RENDER_KEY = `${renderer.sha.slice(0, 12)}-${PLACEMENT}-${AVATAR_MODEL}`;
const log = (line) => { const l = `${new Date().toISOString()} ${line}`; console.log(line); appendFileSync(join(WORK, "run.log"), l + "\n"); };
const save = () => saveState(STATE_PATH, state);
let spentThisRun = 0, stopReason = null;
const run = { started_at: new Date().toISOString(), variant: VARIANT, model: MODEL.name, renderer: { repo: RENDERER_REPO, ref: RENDERER_REF, sha: renderer.sha }, placement: PLACEMENT, max_usd: MAX_USD === Infinity ? null : MAX_USD, calls: [] };
state.runs.push(run);
log(`produce ${VARIANT}: ${MODEL.endpoint} ${MODEL.resolution}, renderer ${RENDERER_REF} @ ${renderer.sha.slice(0, 12)} (--placement ${PLACEMENT}), ` +
  `${PAID_RUN ? `cap ${money(MAX_USD)} this run` : FAKE ? "FAKE repaint (free)" : "render only (free of fal)"}; plan ${table.batches} batches, ${money(table.total_usd)} to go`);

let fal = null, avatarUrl = null;
if (PAID_RUN) {
  const { falClient, falKey } = await import("./produce/fal.mjs");
  fal = await falClient(falKey());
}

/**
 * Run a Modal entrypoint with a JSON spec; returns the result JSON it wrote. Network drops are retried with backoff
 * (MODAL_RETRIES, default 6, 30 s .. 5 min apart); the Modal steps are idempotent (renders already on the volume are
 * reused, takes are fetched once, finish is incremental), so a retry never redoes finished work or costs fal money.
 */
async function modal(file, entry, spec, env = {}) {
  const tries = Math.max(1, Number(process.env.MODAL_RETRIES ?? 6));
  for (let i = 1; ; i++) {
    try { return await modalOnce(file, entry, spec, env); }
    catch (e) {
      if (i >= tries) throw e;
      const wait = Math.min(300, 30 * 2 ** (i - 1));
      log(`${e.message}; retry ${i}/${tries - 1} in ${wait} s (network drop?)`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}
function modalOnce(file, entry, spec, env = {}) {
  const dir = join(WORK, "modal");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const specPath = join(dir, `${entry ?? "main"}-${stamp}.json`), result = join(dir, `${entry ?? "main"}-${stamp}.result.json`);
  writeFileSync(specPath, JSON.stringify({ ...spec, result }, null, 1));
  const target = `${join(REPO, "pipeline/produce", file)}${entry ? `::${entry}` : ""}`;
  const childEnv = Object.fromEntries(Object.entries({ ...process.env, ...env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }).filter(([k]) => !/^(FAL_KEY|OPENAI_API_KEY)/i.test(k)));
  return new Promise((ok, fail) => {
    const child = spawn(process.env.MODAL_BIN ?? "modal", ["run", target, "--spec", specPath], { cwd: REPO, env: childEnv, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0 || !existsSync(result)) return fail(new Error(`modal run ${file}${entry ? `::${entry}` : ""} failed (exit ${code}); spec ${specPath}`));
      ok(JSON.parse(readFileSync(result, "utf8")));
    });
  });
}

/** Keep the state in step with the plan: new batches in, unpaid batches the plan no longer has out. */
function syncState(pl) {
  const keep = new Set(pl.batches.map((b) => b.name));
  for (const [name, b] of Object.entries(state.batches)) if (!batchIsPaid(b) && !keep.has(name)) delete state.batches[name];
  for (const b of pl.batches) {
    if (b.frozen) continue;
    const old = state.batches[b.name];
    state.batches[b.name] = { ...b, takes: old?.takes ?? [], render: old?.render ?? b.render ?? null, segments: old?.segments ?? b.segments };
  }
  save();
}

// ── Render + QC gate ────────────────────────────────────────────────────────────
async function renderStep(batches) {
  if (!batches.length) return;
  const jobs = batches.map((b) => {
    const { motionPath } = writeBatch(b, P.neutral, join(WORK, "batches"));
    return { name: b.name, motion_local: motionPath, motion_vol: `${VOL}/motion/${b.name}.clean.json`, out_vol: `${VOL}/renders/${b.name}-${RENDER_KEY}.mp4`,
      out_local: join(WORK, "renders", `${b.name}-${RENDER_KEY}.mp4`), report_local: join(WORK, "renders", `${b.name}-${RENDER_KEY}.json`) };
  });
  save();
  log(`render: ${jobs.length} batch(es) on Modal`);
  const models = opt["avatar-glb"] ? [[resolve(opt["avatar-glb"]), `/models/${AVATAR_MODEL}.glb`]] : [];
  const res = await modal("modal_render_prod.py", null, { avatar_model: AVATAR_MODEL, placement: PLACEMENT, render_fps: 24, sha: renderer.sha, models, jobs },
    { PRODUCE_PUPPET_DIR: renderer.dir });
  for (const j of jobs) {
    const b = state.batches[j.name], r = res.results.find((x) => x.name === j.name);
    if (!r?.ok) throw new Error(`render failed for ${j.name}: ${r?.error ?? "no result"} ${r?.log_tail ?? ""}`);
    if (r.sha !== renderer.sha) throw new Error(`${j.name}: Modal rendered with ${r.sha}, expected ${renderer.sha}`);
    if (r.frames_video !== b.frames) throw new Error(`${j.name}: puppet render has ${r.frames_video} frames, the motion has ${b.frames}; rejected (timing must be frame-exact)`);
    const report = JSON.parse(readFileSync(j.report_local, "utf8"));
    const qc = renderQc(report, b.segments, b.signs, QC_T);
    b.render = { key: RENDER_KEY, ok: true, sha: r.sha, frames: r.frames_video, vol: j.out_vol, local: j.out_local, report_local: j.report_local,
      motion_vol: j.motion_vol, placement: r.placement, s_per_frame: r.s_per_frame, wall_s: r.wall_s, at: new Date().toISOString(),
      qc: { ok: qc.ok, signs: qc.signs.map(({ motion_id, gloss, frames, bad_frames, bad_pct, palm_flips, pass, reasons }) => ({ motion_id, gloss, frames, bad_frames, bad_pct, palm_flips, pass, reasons })) } };
    log(`render ${b.name}: ${r.frames_video} frames, ${r.wall_s} s, QC ${qc.ok ? "pass" : `FAIL ${qc.signs.filter((s) => !s.pass).map((s) => s.motion_id).join(" ")}`}`);
  }
  save();
}

/** Signs that failed the render QC are dropped (logged in qc.json); returns how many. */
function applyQc(batches) {
  let n = 0;
  for (const b of batches) {
    if (batchIsPaid(b) || !b.render?.qc || b.render.qc.ok) continue;
    for (const s of b.render.qc.signs.filter((x) => !x.pass)) {
      state.qc_rejected[s.motion_id] = { gloss: s.gloss, reasons: s.reasons, bad_pct: s.bad_pct, palm_flips: s.palm_flips, batch: b.name, renderer: RENDER_KEY, at: new Date().toISOString() };
      log(`QC drop ${s.motion_id}: ${s.reasons.join("; ")}`);
      n++;
    }
  }
  if (n) writeFileSync(join(WORK, "qc.json"), JSON.stringify({ thresholds: QC_T, rejected: state.qc_rejected }, null, 1));
  save();
  return n;
}

// ── Repaint (fal) ──────────────────────────────────────────────────────────────
/**
 * Phase 1: submit one take (all takes of a round are submitted up front, one after the other, so the --max-usd guard
 * sees every call). The request id is written to the state file the moment fal returns it, before anything waits.
 */
async function submitTake(b, k) {
  b.takes[k] ??= { k, seed: b.seeds[k], status: "planned" };
  const t = b.takes[k];
  if (t.status !== "planned" && t.status !== "submitting") return;
  if (FAKE) {
    Object.assign(t, { status: "completed", request_id: "fake", cost_usd: 0, vol: b.render.vol, url: null, completed_at: new Date().toISOString() });
    return save();
  }
  if (t.status === "submitting" && !t.request_id) {
    if (!opt["resubmit-unknown"]) { log(`SKIP ${b.name} take ${k}: a submit started on ${t.submitted_at} but no request id came back; check the fal dashboard, then --resubmit-unknown`); return; }
    t.status = "planned";
    state.spent_usd = round(state.spent_usd - (t.cost_usd ?? 0), 3);
  }
  if (stopReason) return;
  try { guardSpend({ spentThisRun, cost: b.cost_per_take, maxUsd: MAX_USD }); }
  catch (e) { stopReason = e.message; log(`STOP: ${e.message}`); return; }
  try {
    // Uploads are free and may fail on a bad network: nothing is committed until the submit call starts.
    if (b.render.fal_url_at && Date.now() - Date.parse(b.render.fal_url_at) > 12 * 3600_000) b.render.fal_url = null;   // stale storage URL
    if (!b.render.fal_url) Object.assign(b.render, { fal_url: await fal.upload(b.render.local), fal_url_at: new Date().toISOString() });
    if (MODEL.avatarImage) avatarUrl ??= await fal.upload(AVATAR_IMAGE);
  } catch (e) { log(`upload for ${b.name} failed (${String(e?.message ?? e).slice(0, 160)}); not submitted, rerun to retry`); return; }
  const input = modelInput(MODEL, { videoUrl: b.render.fal_url, avatarUrl, frames: b.frames, seed: t.seed, prompt: opt.prompt ?? null, ltxImage: Boolean(opt["ltx-image"]) });
  const refund = (why) => {
    Object.assign(t, { status: "planned", error: why.slice(0, 500) });
    state.spent_usd = round(state.spent_usd - b.cost_per_take, 3);
    spentThisRun = round(spentThisRun - b.cost_per_take, 3);
    save();
  };
  spentThisRun = round(spentThisRun + b.cost_per_take, 3);   // committed from here: the paid call starts
  Object.assign(t, { status: "submitting", submitted_at: new Date().toISOString(), cost_usd: b.cost_per_take, endpoint: MODEL.endpoint, model: MODEL.name,
    input: { ...input, video_url: "(puppet render)", ...(input.reference_image_urls ? { reference_image_urls: ["(avatar)"] } : {}), ...(input.image_url ? { image_url: "(avatar)" } : {}) } });
  state.spent_usd = round(state.spent_usd + b.cost_per_take, 3);
  save();
  for (let attempt = 1; ; attempt++) {
    try {
      const id = await fal.submit(MODEL.endpoint, input);
      if (!id) throw new Error("fal returned no request id");
      Object.assign(t, { status: "submitted", request_id: id, error: undefined });
      save();                                                  // the id is on disk before we wait on it
      run.calls.push({ batch: b.name, take: k, request_id: id, cost_usd: b.cost_per_take });
      appendFileSync(join(WORK, "requests.log"), `${new Date().toISOString()} ${b.name} take ${k} seed ${t.seed} ${MODEL.endpoint} ${MODEL.resolution} ${id} $${b.cost_per_take.toFixed(3)} frames ${b.frames} (${b.signs.map((s) => s.motion_id).join(" ")})\n`);
      log(`submitted ${b.name} take ${k} (seed ${t.seed}): ${id}, $${b.cost_per_take.toFixed(3)}; this run $${spentThisRun.toFixed(2)} of ${money(MAX_USD)}`);
      save();
      return;
    } catch (e) {
      const st = e?.status ?? e?.response?.status;
      const code = e?.cause?.code ?? e?.code;
      const msg = String(e?.body?.detail ? JSON.stringify(e.body.detail) : e?.message ?? e);
      // 429 / concurrency limit: fal did not take the job. Wait and retry, never failing the run.
      if ((st === 429 || /concurren|rate.?limit|too many/i.test(msg)) && attempt < 40) {
        const wait = Math.min(120, 5 * 2 ** Math.min(attempt, 5));
        log(`fal busy (${st ?? "limit"}) on ${b.name} take ${k}; retry ${attempt} in ${wait} s`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      // Refused by fal (validation, auth, no credit) or never sent (no connection): not a billed job.
      if ((st >= 400 && st < 500) || ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) {
        refund(msg);
        log(`submit ${b.name} take ${k} refused (${st ?? code}): ${msg.slice(0, 200)}`);
        if (st === 401 || st === 403) stopReason = `fal refused the key (${st}): ${msg.slice(0, 120)}`;
        return;
      }
      // Unknown outcome (connection dropped mid-call): stays "submitting", counted as spent, never resubmitted
      // automatically. Check the fal dashboard; rerun with --resubmit-unknown only if fal has no such request.
      log(`submit ${b.name} take ${k}: outcome unknown (${msg.slice(0, 160)}); counted as spent, not resubmitted`);
      save();
      return;
    }
  }
}

/** Phase 2: wait for a submitted take (all in parallel). A network problem leaves it "submitted" for the next run. */
async function waitTake(b, t) {
  try {
    const data = await fal.wait(MODEL.endpoint, t.request_id);
    const url = data?.video?.url;
    Object.assign(t, url ? { status: "completed", url, seed_used: data?.seed ?? t.seed, completed_at: new Date().toISOString() }
      : { status: "failed_after_submit", error: `no video in result: ${JSON.stringify(data).slice(0, 200)}` });
    t.vol = `${VOL}/takes/${b.name}-t${t.k}.mp4`;
    log(`${url ? "completed" : "FAILED"} ${b.name} take ${t.k} (${t.request_id})`);
  } catch (e) {
    if (e?.code === "failed") { Object.assign(t, { status: "failed_after_submit", error: String(e?.message ?? e).slice(0, 500) }); log(`FAILED ${b.name} take ${t.k} (${t.request_id}): ${t.error}`); }
    else log(`still waiting on ${t.request_id} (${String(e?.message ?? e).slice(0, 120)}); rerun to pick it up (no new spend)`);
  }
  save();
}

async function recastStep(batches) {
  // 1. submit every take of the round up front (serial: the cap is checked before each call)
  for (const b of batches) for (let k = 0; k < b.n_takes; k++) await submitTake(b, k);
  // 2. poll them all in parallel (--concurrency bounds the polling workers; fal runs its own queue)
  const waits = batches.flatMap((b) => (b.takes ?? []).filter((t) => t?.status === "submitted").map((t) => [b, t]));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, waits.length) }, async () => {
    while (next < waits.length) { const [b, t] = waits[next++]; await waitTake(b, t); }
  }));
}

// ── Fetch + frame check + finger score (Modal) ───────────────────────────────────
async function postStep() {
  const jobs = [];
  for (const b of Object.values(state.batches)) {
    const takes = (b.takes ?? []).filter((t) => t && (t.status === "completed" || (DO_SCORE && t.status === "done" && !t.scores)));
    if (!takes.length) continue;
    jobs.push({ name: b.name, ref_vol: b.render.vol, motion_vol: b.render.motion_vol, segments: b.segments, expect_frames: b.expect_out_frames ?? b.frames,
      score: DO_SCORE, takes: takes.map((t) => [t.k, t.vol, t.url ?? null]) });
  }
  if (!jobs.length) return;
  log(`post: fetching, frame-checking${DO_SCORE ? " and scoring" : ""} ${jobs.reduce((s, j) => s + j.takes.length, 0)} take(s) on Modal`);
  const res = await modal("modal_post.py", "score", { jobs });
  for (const r of res.results) {
    const b = state.batches[r.name];
    if (r.error) { log(`post ${r.name} failed: ${r.error.slice(0, 300)}`); continue; }
    if (r.score_error) log(`post ${r.name}: finger score failed (clips still made): ${r.score_error.slice(0, 300)}`);
    for (const m of r.takes_meta) {
      const t = b.takes[m.k];
      t.frames = m.frames;
      if (t.status === "completed") {
        t.status = m.ok ? "done" : "rejected";
        if (!m.ok) { t.error = `output has ${m.frames} frames, expected ${b.expect_out_frames ?? b.frames}: not cut (timing must be frame-exact)`; log(`REJECT ${b.name} take ${m.k}: ${t.error}`); }
      }
      const sc = r.score?.takes?.find((x) => x.k === m.k);
      if (sc) t.scores = { all: sc.all, per_sign: sc.per_sign };
      else if (r.score_error && m.ok) t.scores = { error: r.score_error.slice(0, 300) };   // not retried every round
      if (t.status === "done") state.finish_needed = true;
    }
  }
  save();
}

// ── Cut + even + manifest (Modal) ───────────────────────────────────────────────
const fingerOf = (sc) => sc && { shape_vs_motion: sc.vs_motion?.handshape_change_pct ?? null, err_vs_motion: sc.vs_motion?.mean_joint_err_deg ?? null,
  shape_vs_ref: sc.vs_ref?.handshape_change_pct ?? null, err_vs_ref: sc.vs_ref?.mean_joint_err_deg ?? null, drop_pct: sc.vs_ref?.drop_pct ?? null };

async function finishStep() {
  const batches = Object.values(state.batches).filter((b) => doneTakes(b).length);
  if (!batches.length) { state.finish_needed = false; return; }
  const rows = batches.flatMap((b) => pickBest(b));
  const best = bestPerSign(rows);
  const label = (b, k) => `${VARIANT}/${b.name}/t${k}`;
  const clips = [...best.values()].map((r) => {
    const b = state.batches[r.batch], t = b.takes[r.take], c = cutPoints(b.segments, b.every)[r.index];
    const s = b.signs[r.index], q = b.render?.qc?.signs?.[r.index];
    return { id: r.motion_id, gloss: displayGloss(r.gloss), video: `/vol${t.vol}`, source_video: label(b, t.k), a: c.a, b: c.b, every: b.every,
      aliases: (r.aliases ?? []).map((g) => ({ id: toId(g), gloss: displayGloss(g) })),
      extra: { set: SET, variant: VARIANT, batch: b.name, take: t.k, takes: doneTakes(b).length, seed: t.seed_used ?? t.seed, request_id: t.request_id,
        model: MODEL.name, endpoint: MODEL.endpoint, resolution: MODEL.resolution, cost_usd: t.cost_usd, renderer: b.render?.sha?.slice(0, 12) ?? null,
        placement: b.render?.placement ?? PLACEMENT, avatar_model: AVATAR_MODEL, motion: s.path, motion_kind: s.kind, finger: fingerOf(r.score),
        render_qc: q ? { bad_pct: q.bad_pct, palm_flips: q.palm_flips } : null } };
  });
  const sentences = SET !== "sentences" ? [] : batches.map((b) => {
    const takes = doneTakes(b);
    const score = (t) => { const ks = (t.scores?.per_sign ?? []).map((p) => lib.signKey(p)[0]).filter(Number.isFinite); return ks.length ? ks.reduce((a, x) => a + x, 0) / ks.length : Infinity; };
    const t = takes.reduce((a, x) => (score(x) < score(a) ? x : a), takes[0]);
    return { id: b.sentence.id, video: `/vol${t.vol}`, source_video: label(b, t.k), every: b.every, frames: b.frames,
      meta: { text: b.sentence.text, glosses: b.sentence.glosses, batch: b.name, take: t.k, request_id: t.request_id, seed: t.seed_used ?? t.seed, model: MODEL.name } };
  });
  // Every clip of a sentence's take is cut, so its job (and the sentence video) gets evened even if another sentence
  // won some of its signs.
  if (SET === "sentences") {
    const have = new Set(clips.map((c) => c.source_video));
    for (const s of sentences) if (!have.has(s.source_video)) log(`note: sentence ${s.id} has no winning sign clip; its video is thinned but not evened`);
  }
  const target = FAKE ? "/vol/produce/even-target-fake.json" : `/vol/produce/even-target-${MODEL.resolution}.json`;
  log(`finish: ${clips.length} clip(s)${sentences.length ? ` + ${sentences.length} sentence video(s)` : ""} on Modal -> ${OUT_DIR}`);
  const stage = join(WORK, "stage", new Date().toISOString().replace(/[:.]/g, "-"));
  await modal("modal_post.py", "finish", { stage, finish: { final: `/vol${VOL}/final`, target, color: true, clips, sentences } });
  installStage(stage, OUT_DIR);
  state.finish_needed = false;
  save();
}

/** Copy what Modal sent back into the served folder: media first, manifest.json last (atomic rename). */
function installStage(stage, out) {
  mkdirSync(out, { recursive: true });
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(relative(stage, p)); } };
  walk(stage);
  const order = (f) => (f === "manifest.json" ? 2 : f.endsWith(".json") || f.endsWith(".txt") ? 1 : 0);
  for (const f of files.sort((a, b) => order(a) - order(b))) {
    const dst = join(out, f);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(stage, f), `${dst}.tmp`);
    renameSync(`${dst}.tmp`, dst);
  }
  const res = existsSync(join(stage, "finish-result.json")) ? JSON.parse(readFileSync(join(stage, "finish-result.json"), "utf8")) : {};
  log(`installed ${files.length} file(s) into ${out}: ${res.clips ?? "?"} manifest entries (${res.aliases ?? 0} aliases), ${res.sentences ?? 0} sentence video(s)`);
}

// ── Main loop: chunks of batches in plan order (library: most frequent words first) ─────────────────────────
try {
  for (let round_ = 0; round_ < 200 && !stopReason; round_++) {
    const pl = round_ === 0 ? p0 : plan();
    syncState(pl);
    // Work left: unpaid takes, or paid takes still running at fal (a resumed run polls them, no new spend).
    const polling = (b) => (b.takes ?? []).some((t) => t?.status === "submitted" || (t?.status === "submitting" && opt["resubmit-unknown"]));
    const todo = pl.batches.map((b) => state.batches[b.name]).filter((b) => remainingCost(b) > 0 || polling(b));
    const room = MAX_USD - spentThisRun;
    const chosen = (PAID_RUN ? budgetPrefix(todo, room, remainingCost) : todo).slice(0, CHUNK);
    if (!chosen.length) { if (todo.length && PAID_RUN) stopReason = `next batch (${money(remainingCost(todo[0]))}) does not fit in the ${money(room)} left of --max-usd`; break; }
    for (const b of chosen) if (!b.segments) planMod.attachSegments(b, JSON.parse(readFileSync(P.neutral, "utf8")));
    await renderStep(chosen.filter((b) => !batchIsPaid(b) && (b.render?.key !== RENDER_KEY || !b.render?.ok)));
    if (applyQc(chosen)) { log("render QC dropped sign(s): re-packing the rest"); continue; }
    if (STOP === "render") { log(`--stop-after render: ${chosen.length} batch(es) rendered and passed QC`); break; }
    await recastStep(chosen);
    if (STOP === "recast") break;
    await postStep();
    if (STOP === "score") break;
    if (state.finish_needed) await finishStep();
  }
  if (STOP !== "render" && STOP !== "recast") { await postStep(); if (STOP !== "score" && state.finish_needed) await finishStep(); }
} finally {
  run.finished_at = new Date().toISOString();
  run.spent_usd = round(spentThisRun, 3);
  run.stop_reason = stopReason;
  save();
  printSummary();
}

// ── Output ──────────────────────────────────────────────────────────────────────
function printDryRun(pl, t) {
  if (opt.json) { console.log(JSON.stringify({ set: SET, variant: VARIANT, model: MODEL.name, qc: pl.qc, skipped: pl.skipped, ...t }, null, 1)); return; }
  const rowsMax = Number(opt.rows ?? (SET === "library" ? 12 : 100));
  console.log(`DRY RUN (nothing paid, nothing rendered). Set ${SET}: ${SETS[SET].note}`);
  console.log(`model ${MODEL.name}: ${MODEL.endpoint} ${MODEL.resolution}; price ${MODEL.price}`);
  console.log(`speed ${SETS[SET].every === 2 ? "half (compose 48 fps, render 24 fps, cut every 2nd frame)" : "normal (24 fps)"}; takes per batch ${pl.takes}; batches <= ${pl.cfg.maxVideoS} s of video`);
  let rend = "";
  try { rend = execFileSync("git", ["-C", RENDERER_REPO, "rev-parse", "--short=12", `${RENDERER_REF}^{commit}`]).toString().trim(); } catch { rend = "NOT FOUND"; }
  console.log(`renderer ${RENDERER_REPO} @ ${RENDERER_REF} (${rend}), --avatar ${AVATAR_MODEL} --placement ${PLACEMENT}, passes rgb`);
  console.log(`motion QC: ${pl.qc.requested} signs requested, ${pl.qc.pass_v2 + pl.qc.pass_clean} pass (${pl.qc.pass_v2} WiLoR v2, ${pl.qc.pass_clean} v1 clean), ${pl.qc.fail} fail; ` +
    `${pl.qc.render_qc_rejected} rejected by render QC earlier; ${pl.qc.covered} already paid for`);
  if (pl.skipped.length) {
    const why = {};
    for (const s of pl.skipped) { const k = String(s.reason).replace(/[0-9.]+/g, "N").slice(0, 60); why[k] = (why[k] ?? 0) + 1; }
    console.log(`skipped ${pl.skipped.length}: ${Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${n}x ${k}`).join(" | ")}`);
    for (const s of pl.skipped.slice(0, SET === "library" ? 5 : 20)) console.log(`  - ${s.gloss ?? `"${s.sentence}"`}: ${s.reason}`);
  }
  console.table(t.rows.slice(0, rowsMax).map(({ batch, signs, n, v2, frames, video_s, takes, usd_per_take, usd }) => ({ batch, signs: signs.length > 60 ? signs.slice(0, 57) + "..." : signs, n, v2, frames, video_s, takes, usd_per_take, usd })));
  if (t.rows.length > rowsMax) console.log(`... ${t.rows.length - rowsMax} more batches (--rows N to show them)`);
  console.log(`TOTAL to go: ${t.batches} batches, ${t.signs} signs, ${t.calls} ${MODEL.name} calls, ${t.video_s} s of video, EXACT COST ${money(t.total_usd)}` +
    (state.spent_usd ? `  (already spent: ${money(state.spent_usd)})` : ""));
  if (opt["max-usd"]) {
    const fit = budgetPrefix(pl.batches, Number(opt["max-usd"]), remainingCost);
    console.log(`--max-usd ${opt["max-usd"]}: the first ${fit.length} batches (${fit.reduce((s, b) => s + b.signs.length, 0)} signs, ${money(fit.reduce((s, b) => s + remainingCost(b), 0))}) fit`);
  }
  console.log(`output: ${OUT_DIR}   state: ${STATE_PATH}`);
  console.log(`paid: add --execute --authorize-paid ${PAID_TOKEN} --max-usd ${Math.ceil(t.total_usd)} (with FAL_KEY set)`);
}

function printSummary() {
  const rows = Object.values(state.batches).filter((b) => (b.takes ?? []).some((t) => t?.request_id)).map((b) => ({
    batch: b.name, signs: b.signs.map((s) => s.motion_id).join(" ").slice(0, 40),
    takes: b.takes.filter(Boolean).map((t) => `${t.k}:${t.status}`).join(" "),
    request_ids: b.takes.filter((t) => t?.request_id).map((t) => t.request_id).join(" "),
    usd: round(b.takes.filter((t) => t && lib.takeIsPaid(t)).reduce((s, t) => s + (t.cost_usd ?? 0), 0), 3) }));
  if (rows.length) console.table(rows);
  console.log(`this run: ${money(spentThisRun)} committed${MAX_USD !== Infinity ? ` of ${money(MAX_USD)}` : ""}; lifetime ${money(state.spent_usd)}; ${stopReason ? `stopped: ${stopReason}` : "done"}`);
  console.log(`state ${STATE_PATH}; requests ${join(WORK, "requests.log")}; clips ${OUT_DIR}`);
}
