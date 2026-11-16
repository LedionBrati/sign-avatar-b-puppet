// Plan a set: which batches, their exact frames / video seconds / cost, frame-exact segments.
// Frame counts come from lib.mjs batchFrames (an exact mirror of puppet/src/blend.ts), so planning the whole
// dictionary needs only each motion's frame count and fps (lib.mjs metaCache). composeBatch builds the real motion
// with blend.ts (node --experimental-strip-types) and checks it against the plan.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  REPO, RENDER_FPS, SETS, batchFrames, batchIsPaid, batchName, coveredSigns, displayGloss, dictionaryVocab, expectedOutFrames,
  getModel, innerPureNeutral, modelCost, motionStamp, packBatches, paidTakes, round, takeSeeds,
} from "./lib.mjs";

const { concatClips } = await import(pathToFileURL(join(REPO, "puppet/src/blend.ts")).href);

export const BLEND_S = 0.2;
export const MIN_PURE = 3;   // still neutral frames (composed) at every cut (make-batches.mjs --min-pure)

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const meta = (m) => ({ frames: m.frames, fps: m.fps });

/**
 * Hold the last neutral until the video reaches the model's minimum (Recast: 5 s), and for LTX until the frame count
 * is 8n+1 (so the output has exactly the input's frames).
 */
export function holdFor(signMetas, neutralMeta, fps, model) {
  const minFrames = model.minVideoS > 0 ? Math.ceil(model.minVideoS * RENDER_FPS) + 1 : 9;
  const ok = (n) => n >= minFrames && (!model.align8 || n % 8 === 1);
  let hold = 0;
  for (let n = batchFrames(signMetas, neutralMeta, { fps, blend: BLEND_S }), guard = 0; !ok(n); guard++) {
    if (guard > 2000) throw new Error("could not pad the batch");
    const need = n < minFrames ? minFrames - n : 1;
    hold = round(hold + need / fps, 6);
    n = batchFrames(signMetas, neutralMeta, { fps, blend: BLEND_S, holdEnd: hold });
  }
  return hold;
}

/** Compose NEUTRAL S1 NEUTRAL ... NEUTRAL for real (blend.ts) and check it against the planned frame count. */
export function composeBatch(b, neutral) {
  const clips = [{ motion: neutral }];
  for (const s of b.signs) clips.push({ motion: readJson(s.path) }, { motion: neutral });
  if (b.hold_end_s > 0) clips[clips.length - 1].holdEnd = b.hold_end_s;
  const { motion, segments } = concatClips(clips, { blend: BLEND_S, fps: b.compose_fps });
  if (motion.frames.length !== b.frames) throw new Error(`${b.name}: composed ${motion.frames.length} frames, planned ${b.frames}`);
  motion.name = b.name;
  motion.source.parts = clips.map(({ motion: m }) => ({ name: m.name, motion_id: m.motion_id ?? null, gloss: m.gloss,
    file: m.source?.file ?? null, dataset: m.source?.dataset ?? null, signer: m.source?.signer ?? null }));
  const segs = segments.map((s) => ({ gloss: s.gloss, start: s.start, end: s.end }));
  motion.cleanup.segments = segs;
  return { motion, segments: segs };
}

function makeBatch({ set, cfg, model, signs, neutralMeta, neutralPath, takes, seedBase, sentence = null }) {
  const fps = cfg.composeFps;
  const metas = signs.map(meta);
  const hold = holdFor(metas, neutralMeta, fps, model);
  const frames = batchFrames(metas, neutralMeta, { fps, blend: BLEND_S, holdEnd: hold });
  const name = batchName(set, { v: 1, fps, every: cfg.every, blend: BLEND_S, hold, align8: model.align8, neutral: motionStamp(neutralPath),
    signs: signs.map((s) => [s.motion_id, motionStamp(s.path)]), sentence: sentence?.text ?? null });
  return {
    name, set, model: model.name, compose_fps: fps, render_fps: RENDER_FPS, every: cfg.every, hold_end_s: hold, frames,
    expect_out_frames: expectedOutFrames(model, frames), video_s: round(frames / RENDER_FPS, 3), clip_s: round(frames / fps, 3),
    cost_per_take: modelCost(model, frames), n_takes: takes, seeds: takeSeeds(takes, seedBase),
    signs: signs.map(({ gloss, motion_id, path, kind, stem, aliases }) => ({ gloss, motion_id, path, kind, stem, ...(aliases?.length ? { aliases } : {}) })),
    ...(sentence ? { sentence } : {}),
  };
}

/**
 * @param {object} o
 * @param {"demo"|"sentences"|"library"} o.set
 * @param {string} [o.model]             recast1080 (default) | recast768 | ltx_r2r
 * @param {(string|{gloss, aliases?})[]} [o.glosses]   demo / library, in priority order
 * @param {string[]} [o.sentences]        sentences mode: English text, one take each
 * @param {ReturnType<import("./lib.mjs").motionLibrary>} o.lib
 * @param {string} o.neutralPath
 * @param {object} o.state                loadState(): batches with spend stay exactly as they were
 * @param {(text: string, vocab: object[]) => object} [o.translate]   translateRules from translate/index.mjs
 * @param {number} [o.takes] [o.seedBase] [o.maxVideoS] [o.verify]  verify = compose the first N new batches for real
 */
export function planSet(o) {
  const cfg = { ...SETS[o.set] };
  if (!cfg.composeFps) throw new Error(`unknown set ${o.set}`);
  const model = getModel(o.model ?? "recast1080");
  cfg.maxVideoS = Math.min(Number(o.maxVideoS ?? cfg.maxVideoS), model.maxVideoS);
  const packLimit = cfg.maxVideoS - (model.align8 ? 8 / RENDER_FPS : 0);   // room for the 8n+1 hold
  const takes = Number(o.takes ?? cfg.takes);
  if (!(Number.isInteger(takes) && takes >= 1 && takes <= 8)) throw new Error("--takes must be 1..8");
  const seedBase = Number(o.seedBase ?? 4242);
  const neutralJson = readJson(o.neutralPath), neutralMeta = { frames: neutralJson.frames.length, fps: neutralJson.fps };
  const rejectedQc = o.state.qc_rejected ?? {};
  const frozen = Object.values(o.state.batches).filter(batchIsPaid);
  const skipped = [], qcStats = { requested: 0, pass_v2: 0, pass_clean: 0, fail: 0, render_qc_rejected: 0, covered: 0 };
  let fresh = [];

  if (o.set === "sentences") {
    const vocab = dictionaryVocab(o.lib.stems);
    const doneText = new Set(frozen.map((b) => b.sentence?.text));
    for (const [n, text] of (o.sentences ?? []).entries()) {
      if (doneText.has(text)) { qcStats.covered++; continue; }
      const plan = o.translate(text, vocab);
      const items = plan.items ?? [];
      const bad = [...(plan.unsupported_tokens ?? []), ...items.filter((i) => i.type !== "sign").map((i) => i.gloss ?? i.type)];
      if (!plan.ok || bad.length) { skipped.push({ sentence: text, reason: `not fully signable: ${bad.join(", ") || "no signs"}` }); continue; }
      const signs = items.map((i) => o.lib.resolve(i.gloss));
      qcStats.requested += signs.length;
      for (const s of signs) { if (!s.path) qcStats.fail++; else qcStats[s.kind === "v2" ? "pass_v2" : "pass_clean"]++; }
      const missing = signs.filter((s) => !s.path);
      if (missing.length) { skipped.push({ sentence: text, reason: missing.map((s) => `${s.gloss}: ${s.error}`).join("; ") }); continue; }
      const qcBad = signs.filter((s) => rejectedQc[s.motion_id]);
      if (qcBad.length) { qcStats.render_qc_rejected += qcBad.length; skipped.push({ sentence: text, reason: `render QC rejected ${qcBad.map((s) => `${s.motion_id} (${rejectedQc[s.motion_id].reasons.join("; ")})`).join(", ")}` }); continue; }
      const id = `s${String(n + 1).padStart(2, "0")}-${signs.map((s) => s.motion_id.toLowerCase()).join("-").slice(0, 48)}`;
      const b = makeBatch({ set: o.set, cfg, model, signs, neutralMeta, neutralPath: o.neutralPath, takes, seedBase,
        sentence: { id, text, glosses: signs.map((s) => s.gloss), plan: items.map((i) => i.motion_id) } });
      if (b.video_s > cfg.maxVideoS) { skipped.push({ sentence: text, reason: `${b.video_s} s of video at half speed (> ${cfg.maxVideoS} s single-shot limit); split it` }); continue; }
      fresh.push(b);
    }
  } else {
    const covered = coveredSigns(o.state);
    const seen = new Set(), todo = [];
    for (const item of o.glosses ?? []) {
      const g = typeof item === "string" ? item : item.gloss;
      const r = o.lib.resolve(g);
      if (r.path && seen.has(r.motion_id)) continue;
      qcStats.requested++;
      if (!r.path) { qcStats.fail++; skipped.push({ gloss: displayGloss(g), reason: r.error }); continue; }
      qcStats[r.kind === "v2" ? "pass_v2" : "pass_clean"]++;
      seen.add(r.motion_id);
      const c = covered.get(r.motion_id);
      if (c && !(o.redoUpgraded && c.kind === "clean" && r.kind === "v2")) { qcStats.covered++; continue; }
      const q = rejectedQc[r.motion_id];
      if (q && !o.retryQc) { qcStats.render_qc_rejected++; skipped.push({ gloss: r.gloss, reason: `render QC: ${q.reasons.join("; ")}` }); continue; }
      const aliases = typeof item === "string" ? [] : (item.aliases ?? []).map(displayGloss);
      todo.push({ ...r, aliases });
    }
    let groups = null;
    while (todo.length && !groups) {
      try { groups = packBatches(todo.map(meta), neutralMeta, { fps: cfg.composeFps, blend: BLEND_S, maxVideoS: packLimit }); }
      catch (e) {
        if (e.sign === undefined) throw e;
        const [s] = todo.splice(e.sign, 1);
        skipped.push({ gloss: s.gloss, reason: e.message });
        qcStats.fail++; qcStats[s.kind === "v2" ? "pass_v2" : "pass_clean"]--;
      }
    }
    fresh = (groups ?? []).map((ids) => makeBatch({ set: o.set, cfg, model, signs: ids.map((i) => todo[i]), neutralMeta, neutralPath: o.neutralPath, takes, seedBase }));
  }

  // An unpaid batch planned before with the same content keeps its render (and QC verdict).
  for (const b of fresh) {
    const old = o.state.batches[b.name];
    if (old?.render) b.render = old.render;
  }
  // Exact check on a sample (the rest is composed when its batch is rendered).
  for (const b of fresh.slice(0, o.verify ?? 2)) attachSegments(b, neutralJson);
  const batches = [...frozen.map((b) => ({ ...b, frozen: true })), ...fresh];
  return { set: o.set, model: model.name, cfg, takes, batches, skipped, qc: qcStats };
}

/** Compose a batch and attach its frame-exact segments; refuses a batch whose cuts would not land on a still pose. */
export function attachSegments(b, neutral) {
  if (b.segments) return b;
  const { segments } = composeBatch(b, neutral);
  b.segments = segments;
  b.min_pure_neutral = Math.min(...innerPureNeutral(segments), Infinity);   // composed frames, as make-batches.mjs --fps 48 --min-pure 3
  if (b.min_pure_neutral < MIN_PURE) throw new Error(`${b.name}: only ${b.min_pure_neutral} still neutral frames at a cut (< ${MIN_PURE})`);
  return b;
}

/** Remaining paid cost of one batch: takes not yet paid x exact cost per take. */
export const remainingCost = (b) => round(Math.max(0, b.n_takes - paidTakes(b)) * b.cost_per_take, 3);

/** Cost table of a plan. */
export function costTable(plan) {
  const rows = plan.batches.map((b) => {
    const todo = Math.max(0, b.n_takes - paidTakes(b));
    return { batch: b.name, signs: b.sentence ? `"${b.sentence.text}"` : b.signs.map((s) => s.motion_id).join(" "),
      n: b.signs.length, v2: b.signs.filter((s) => s.kind === "v2").length, frames: b.frames, video_s: b.video_s,
      takes: `${todo}/${b.n_takes}`, usd_per_take: b.cost_per_take, usd: remainingCost(b), frozen: Boolean(b.frozen) };
  });
  const todoVideo = plan.batches.reduce((s, b) => s + b.video_s * Math.max(0, b.n_takes - paidTakes(b)), 0);
  return { rows, total_usd: round(rows.reduce((s, r) => s + r.usd, 0), 2), video_s: round(todoVideo, 1),
    signs: rows.reduce((s, r) => s + r.n, 0), batches: rows.length, calls: plan.batches.reduce((s, b) => s + Math.max(0, b.n_takes - paidTakes(b)), 0) };
}

/** Write the batch motion + segment summary (make-batches.mjs format) into dir. */
export function writeBatch(b, neutralPath, dir) {
  mkdirSync(dir, { recursive: true });
  const { motion, segments } = composeBatch(b, readJson(neutralPath));
  const motionPath = join(dir, `${b.name}.clean.json`), segPath = join(dir, `${b.name}.json`);
  writeFileSync(motionPath, JSON.stringify(motion));
  writeFileSync(segPath, JSON.stringify({ out: motionPath, gloss: motion.gloss, frames: motion.frames.length, fps: b.compose_fps,
    render_fps: b.render_fps, every: b.every, seconds: b.clip_s, video_s: b.video_s, padded_s: b.hold_end_s, segments,
    signs: b.signs.map((s) => ({ motion_id: s.motion_id, gloss: s.gloss, kind: s.kind, path: s.path })) }));
  b.segments = segments;
  return { motionPath, segPath };
}
