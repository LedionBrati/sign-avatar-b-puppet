// Unit tests for pipeline/produce.mjs (no fal, no Modal; the finish test runs ffmpeg on a tiny 96x128 video).
//   node --experimental-strip-types --no-warnings --test pipeline/produce/produce.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as L from "./lib.mjs";
import { planSet, costTable, remainingCost, holdFor, composeBatch, attachSegments } from "./plan.mjs";
import { RACE_MODELS, ltxFrames } from "../race/models.mjs";

const { concatClips } = await import(pathToFileURL(join(L.REPO, "puppet/src/blend.ts")).href);
const tmp = () => mkdtempSync(join(tmpdir(), "produce-test-"));

// ── tiny motions ────────────────────────────────────────────────────────────────
function motion(n, fps, { id = "X", gloss = "x", rest = false, hands3d = false } = {}) {
  const P = (v) => Array.from({ length: 33 }, () => [v, v, v, 1]);
  const W = (y) => Array.from({ length: 33 }, (_, k) => [0, k === 15 || k === 16 ? y : -0.4, 0]);   // wrists at y
  return { version: hands3d ? 2 : 1, name: id.toLowerCase(), motion_id: id, gloss, source: { file: null }, fps, width: 1280, height: 720,
    dominant_hand: "right", mirrored: false, cleaned: true, cleanup: {},
    frames: Array.from({ length: n }, (_, i) => ({ i, t: i / fps, pose: P(i), poseWorld: W(rest && i > n / 3 && i < n / 3 + 5 ? 0 : -0.6), face: null,
      leftHand: null, rightHand: Array.from({ length: 21 }, () => [i, i, i]), ...(hands3d ? { hands3d: { left: null, right: { joints: Array.from({ length: 21 }, () => [0, 0, 0]) } } } : {}) })) };
}
function library(dir, signs) {
  // signs: [{gloss, stem, n, fps, kind: v2|clean, pct, rest}]
  const index = {};
  mkdirSync(join(dir, "wlasl3d/hands3d"), { recursive: true });
  mkdirSync(join(dir, "wlasl/rows"), { recursive: true });
  for (const s of signs) {
    index[s.gloss] = { file: `videos/${s.stem}.mp4`, source_url: s.url ?? `u/${s.stem}` };
    const m = motion(s.n, s.fps, { id: L.toId(s.gloss), gloss: s.gloss.toUpperCase(), rest: s.rest, hands3d: s.kind === "v2" });
    if (s.kind === "v2") writeFileSync(join(dir, "wlasl3d/hands3d", `${s.stem}.v2.json`), JSON.stringify(m));
    if (s.kind === "clean" || s.alsoClean) {
      writeFileSync(join(dir, "wlasl", `${s.stem}.clean.json`), JSON.stringify({ ...m, version: 1 }));
      writeFileSync(join(dir, "wlasl/rows", `${s.stem}.json`), JSON.stringify({ name: s.stem, dominant_hand_pct_clean: s.pct ?? 95, error: s.error ?? "" }));
    }
  }
  writeFileSync(join(dir, "index.json"), JSON.stringify(index));
  writeFileSync(join(dir, "neutral.clean.json"), JSON.stringify(motion(13, 24, { id: "NEUTRAL", gloss: null })));
  return { index: join(dir, "index.json"), v2Root: join(dir, "wlasl3d"), cleanDir: join(dir, "wlasl"), neutral: join(dir, "neutral.clean.json") };
}

// ── exact lengths ───────────────────────────────────────────────────────────────
test("batchFrames mirrors blend.ts concatClips exactly (fps, holds, half speed)", () => {
  const neutral = motion(13, 24);
  for (const fps of [24, 48]) {
    for (const lens of [[41], [41, 25, 60], [8, 9, 120, 33, 50]]) {
      for (const hold of [0, 0.37, 2.1]) {
        const signs = lens.map((n, k) => motion(n, k % 2 ? 25 : 29.97));
        const clips = [{ motion: neutral }, ...signs.flatMap((m) => [{ motion: m }, { motion: neutral }])];
        if (hold) clips[clips.length - 1].holdEnd = hold;
        const real = concatClips(clips, { blend: 0.2, fps }).motion.frames.length;
        const est = L.batchFrames(signs.map((m) => ({ frames: m.frames.length, fps: m.fps })), { frames: 13, fps: 24 }, { fps, blend: 0.2, holdEnd: hold });
        assert.equal(est, real, `fps ${fps} lens ${lens} hold ${hold}`);
      }
    }
  }
});

test("holdFor pads to Recast's 5 s and to LTX's 8n+1 frames", () => {
  const n = { frames: 13, fps: 24 };
  const recast = L.getModel("recast1080"), ltx = L.getModel("ltx_r2r");
  const short = [{ frames: 20, fps: 25 }];
  const h = holdFor(short, n, 48, recast);
  assert.ok(L.batchFrames(short, n, { fps: 48, holdEnd: h }) >= 121);
  for (const signs of [short, [{ frames: 60, fps: 25 }, { frames: 47, fps: 30 }]]) {
    const f = L.batchFrames(signs, n, { fps: 24, holdEnd: holdFor(signs, n, 24, ltx) });
    assert.equal(f % 8, 1);
    assert.equal(ltxFrames(f), f, "LTX gets exactly the frames we send");
  }
});

test("packBatches keeps order, respects the limit, balances, and names the sign that cannot fit", () => {
  const n = { frames: 13, fps: 24 };
  const signs = Array.from({ length: 23 }, (_, i) => ({ frames: 30 + (i * 7) % 40, fps: 25 }));
  const b = L.packBatches(signs, n, { fps: 24, maxVideoS: 10 });
  assert.deepEqual(b.flat(), signs.map((_, i) => i));
  for (const g of b) assert.ok(L.batchFrames(g.map((i) => signs[i]), n, { fps: 24 }) / 24 <= 10);
  const greedyCount = L.packBatches(signs, n, { fps: 24, maxVideoS: 10 }).length;
  assert.equal(b.length, greedyCount);
  const lens = b.map((g) => L.batchFrames(g.map((i) => signs[i]), n, { fps: 24 }));
  assert.ok(Math.max(...lens) - Math.min(...lens) < 24 * 4, `balanced: ${lens}`);
  assert.throws(() => L.packBatches([{ frames: 400, fps: 25 }], n, { fps: 24, maxVideoS: 10 }), (e) => e.sign === 0);
});

// ── money ───────────────────────────────────────────────────────────────────────
test("costs come from pipeline/race/models.mjs (recast1080 = the race winner)", () => {
  assert.equal(L.modelCost("recast1080", 240), RACE_MODELS.recast1080.cost({ seconds: 10, frames: 240, fps: 24 }));
  assert.equal(L.modelCost("recast1080", 240), 3.095);   // 0.17 x 10 + 0.022 x (67500 - 4096) / 1000, rounded up
  assert.equal(L.modelCost("recast1080", 60), RACE_MODELS.recast1080.cost({ seconds: 2.5, frames: 60, fps: 24 }));   // 5 s minimum
  assert.equal(L.modelCost("recast768", 240), RACE_MODELS.recast.cost({ seconds: 10, frames: 240, fps: 24 }));
  assert.equal(L.modelCost("ltx_r2r", 241), RACE_MODELS.ltx_r2r.cost({ seconds: 241 / 24, frames: 241, fps: 24 }));
  assert.throws(() => L.getModel("kling"), /--model/);
});

test("model inputs: Recast with the avatar and seed, LTX prompt-only unless asked", () => {
  const r = L.modelInput("recast1080", { videoUrl: "V", avatarUrl: "A", frames: 240, seed: 7 });
  assert.deepEqual(r, { video_url: "V", reference_image_urls: ["A"], resolution: "1080P", enable_safety_checker: true, seed: 7 });
  assert.equal(L.modelInput("recast768", { videoUrl: "V", avatarUrl: "A", frames: 240 }).resolution, "768P");
  assert.throws(() => L.modelInput("recast1080", { videoUrl: "V", avatarUrl: null, frames: 240 }), /avatar/);
  const x = L.modelInput("ltx_r2r", { videoUrl: "V", avatarUrl: null, frames: 241, seed: 3, prompt: "P" });
  assert.equal(x.image_url, undefined);
  assert.equal(x.prompt, "P");
  assert.equal(x.seed, 3);
  assert.equal(x.num_frames, 241);
  assert.ok(L.modelInput("ltx_r2r", { videoUrl: "V", avatarUrl: null, frames: 241 }).prompt.includes("Sign Language"));
  assert.equal(L.modelInput("ltx_r2r", { videoUrl: "V", avatarUrl: "A", frames: 241, ltxImage: true }).image_url, "A");
});

test("the --max-usd guard stops before the call that would cross the cap", () => {
  assert.equal(L.guardSpend({ spentThisRun: 0, cost: 3.1, maxUsd: 10 }), 3.1);
  assert.equal(L.guardSpend({ spentThisRun: 6.9, cost: 3.1, maxUsd: 10 }), 10);
  assert.throws(() => L.guardSpend({ spentThisRun: 7, cost: 3.1, maxUsd: 10 }), (e) => e.code === "max_usd");
  assert.throws(() => L.guardSpend({ spentThisRun: 0, cost: 1, maxUsd: NaN }), /--max-usd/);
  const bs = [{ c: 3 }, { c: 0 }, { c: 4 }, { c: 5 }];
  assert.deepEqual(L.budgetPrefix(bs, 7, (b) => b.c), [bs[0], bs[1], bs[2]]);
});

// ── motion QC + planning + resume ─────────────────────────────────────────────
test("motion library: v2 first, v1 only when it passes QC; aliases; most frequent first", () => {
  const d = tmp();
  const p = library(d, [
    { gloss: "hello", stem: "hello-1", n: 40, fps: 25, kind: "v2", alsoClean: true, pct: 50 },   // v2 wins even if v1 failed QC
    { gloss: "water", stem: "water-1", n: 40, fps: 25, kind: "clean", pct: 95 },
    { gloss: "drink", stem: "drink-1", n: 40, fps: 25, kind: "clean", pct: 60 },                  // hand < 80 %
    { gloss: "twice", stem: "twice-1", n: 150, fps: 25, kind: "clean" },                          // 6 s: two signs?
    { gloss: "pause", stem: "pause-1", n: 40, fps: 25, kind: "clean", rest: true },               // rest dip mid-sign
    { gloss: "gone", stem: "gone-1", n: 40, fps: 25, kind: "none" },
  ]);
  const lib = L.motionLibrary({ index: p.index, v2Root: p.v2Root, cleanDir: p.cleanDir, massState: new Map([["water-1", { status: "kept" }]]) });
  assert.equal(lib.resolve("HELLO").kind, "v2");
  assert.equal(lib.resolve("water").kind, "clean");
  assert.match(lib.resolve("drink").error, /60% of frames/);
  assert.match(lib.resolve("twice").error, /two signs suspected/);
  assert.match(lib.resolve("pause").error, /at rest/);
  assert.match(lib.resolve("gone").error, /no v2 or clean/);
  assert.match(lib.resolve("nope").error, /not in the sign index/);
  const dropped = L.motionLibrary({ index: p.index, v2Root: p.v2Root, cleanDir: p.cleanDir, massState: new Map([["water-1", { status: "dropped", reason: "x" }]]) });
  assert.match(dropped.resolve("water").error, /mass QA/);
  const dict = L.dictionaryGlosses({ a: { source_url: "a" }, go: { source_url: "s1" }, leave: { source_url: "s1" }, the: { source_url: "t" }, zzz: { source_url: "z" } },
    { go: 6, leave: 5, the: 7 });
  assert.deepEqual(dict.map((x) => x.gloss), ["the", "go", "zzz"]);
  assert.deepEqual(dict[1].aliases, ["leave"]);
});

test("planSet: frozen paid batches stay, their signs are never packed again; render-QC rejects are skipped", () => {
  const d = tmp();
  const glosses = ["one", "two", "three", "four", "five", "six"];
  const p = library(d, glosses.map((g) => ({ gloss: g, stem: `${g}-1`, n: 35, fps: 25, kind: "v2" })));
  const lib = L.motionLibrary({ index: p.index, v2Root: p.v2Root, cleanDir: p.cleanDir });
  const state = L.newState("demo");
  const a = planSet({ set: "demo", glosses, lib, neutralPath: p.neutral, state, takes: 2, verify: 99 });
  assert.ok(a.batches.length >= 2);
  const t = costTable(a);
  assert.equal(t.total_usd, L.round(a.batches.reduce((s, b) => s + 2 * b.cost_per_take, 0), 2));
  for (const b of a.batches) {
    assert.equal(b.frames, composeBatch(b, JSON.parse(readFileSync(p.neutral, "utf8"))).motion.frames.length);
    assert.equal(b.segments.filter((s) => s.gloss).length, b.signs.length);
    assert.ok(b.min_pure_neutral >= 3);
    assert.equal(b.video_s, L.round(b.frames / 24, 3));
    assert.ok(b.frames >= 121, "Recast 5 s minimum");
  }
  // pay for take 0 of the first batch: it is frozen, take 1 still to do, its signs never re-packed
  const first = a.batches[0];
  state.batches[first.name] = { ...first, takes: [{ k: 0, status: "submitted", request_id: "r1", cost_usd: first.cost_per_take }] };
  state.qc_rejected.SIX = { reasons: ["palm flip"] };
  const b = planSet({ set: "demo", glosses, lib, neutralPath: p.neutral, state, takes: 2 });
  const fz = b.batches.filter((x) => x.frozen);
  assert.equal(fz.length, 1);
  assert.equal(remainingCost(fz[0]), first.cost_per_take);
  const fresh = b.batches.filter((x) => !x.frozen).flatMap((x) => x.signs.map((s) => s.motion_id));
  for (const s of first.signs) assert.ok(!fresh.includes(s.motion_id), `${s.motion_id} would be paid twice`);
  assert.ok(!fresh.includes("SIX"));
  assert.equal(b.qc.render_qc_rejected, 1);
  assert.equal(b.qc.covered, first.signs.length);
  // the same content gets the same name (resume finds its render)
  const c = planSet({ set: "demo", glosses, lib, neutralPath: p.neutral, state: L.newState("demo"), takes: 2 });
  assert.deepEqual(c.batches.map((x) => x.name), a.batches.map((x) => x.name));
  // v2 carries through compose
  const m = composeBatch(a.batches[0], JSON.parse(readFileSync(p.neutral, "utf8"))).motion;
  assert.equal(m.version, 2);
});

test("planSet sentences: one batch per signable sentence, unsignable ones listed", async () => {
  const { translateRules } = await import("../../translate/index.mjs");
  const d = tmp();
  const p = library(d, ["where", "hurt", "you", "sick"].map((g) => ({ gloss: g, stem: `${g}-1`, n: 35, fps: 25, kind: "v2" })));
  const lib = L.motionLibrary({ index: p.index, v2Root: p.v2Root, cleanDir: p.cleanDir });
  const pl = planSet({ set: "sentences", sentences: ["Where does it hurt?", "Are you sick?", "Are you a zebra?"], translate: translateRules, lib, neutralPath: p.neutral, state: L.newState("sentences"), verify: 9 });
  assert.equal(pl.batches.length, 2);
  assert.deepEqual(pl.batches[0].signs.map((s) => s.motion_id), ["HURT", "WHERE"]);
  assert.equal(pl.batches[0].every, 2);
  assert.equal(pl.batches[0].compose_fps, 48);
  assert.match(pl.skipped[0].reason, /not fully signable/);
});

// ── render QC gate ──────────────────────────────────────────────────────────────
test("render QC: bad-frame share and palm flips per sign, explicit renderer fields win", () => {
  const seg = [{ gloss: null, start: 0, end: 9 }, { gloss: "A", start: 10, end: 109 }, { gloss: null, start: 110, end: 119 }, { gloss: "B", start: 120, end: 219 }, { gloss: null, start: 220, end: 229 }];
  const frames = Array.from({ length: 230 }, (_, i) => ({ i, err: { "R hand dir": 10, "R palm": 20, "R fingers": 10, "R upper arm": 30, "R forearm": 20 } }));
  const signs = [{ motion_id: "A" }, { motion_id: "B" }];
  assert.equal(L.renderQc({ per_frame: frames }, seg, signs).ok, true);
  for (let i = 20; i < 24; i++) frames[i].err["R fingers"] = 70;   // 4 % of A
  frames[150].err["R palm"] = 150;                                 // one jump > 90 deg in B (and a bad frame)
  const q = L.renderQc({ per_frame: frames }, seg, signs);
  assert.equal(q.ok, false);
  assert.equal(q.signs[0].bad_pct, 4);
  assert.match(q.signs[0].reasons[0], /4% bad frames > 3%/);
  assert.ok(q.signs[1].palm_flips >= 1);
  assert.equal(q.signs[1].bad_frames, 1);
  frames[150].err["R palm"] = 20;
  frames[60].err["R upper arm"] = 80;
  assert.equal(L.renderQc({ per_frame: frames }, seg, signs, { ...L.RENDER_QC, armDeg: null, maxBadPct: 5 }).ok, true);   // --qc-arm-deg off
  frames[130].palm_flip = { R: true };
  assert.equal(L.renderQc({ per_frame: frames }, seg, signs, { ...L.RENDER_QC, maxBadPct: 5 }).signs[1].pass, false);
  frames[130].palm_flip = null;
  frames[131].palm_n = { R: [0, 0, 1] }; frames[132].palm_n = { R: [0, 0, -1] };
  assert.match(L.renderQc({ per_frame: frames }, seg, signs, { ...L.RENDER_QC, maxBadPct: 5 }).signs[1].reasons.join(), /palm turned 180/);
  assert.equal(L.renderQc({}, seg, signs).ok, false, "no per-frame data: never paid blind");
});

// ── best take ──────────────────────────────────────────────────────────────────
test("best take per sign: fewer handshape changes, then joint error; v2 beats v1; unscored last", () => {
  const sc = (shape, err) => ({ vs_motion: { handshape_change_pct: shape, mean_joint_err_deg: err }, vs_ref: { drop_pct: 0 } });
  const b = { name: "b1", signs: [{ motion_id: "A", kind: "v2" }, { motion_id: "B", kind: "v2" }], takes: [
    { k: 0, status: "done", scores: { per_sign: [{ index: 0, ...sc(10, 20) }, { index: 1, ...sc(2, 30) }] } },
    { k: 1, status: "done", scores: { per_sign: [{ index: 0, ...sc(5, 40) }, { index: 1, ...sc(2, 25) }] } },
    { k: 2, status: "rejected", scores: { per_sign: [{ index: 0, ...sc(0, 0) }, { index: 1, ...sc(0, 0) }] } }] };
  assert.deepEqual(L.pickBest(b).map((r) => r.take), [1, 1]);
  const unscored = { name: "b2", signs: [{ motion_id: "A", kind: "clean" }], takes: [{ k: 0, status: "done" }] };
  assert.equal(L.pickBest(unscored)[0].take, 0);
  const v1better = { name: "b3", signs: [{ motion_id: "A", kind: "clean" }], takes: [{ k: 0, status: "done", scores: { per_sign: [{ index: 0, ...sc(0, 1) }] } }] };
  const best = L.bestPerSign([...L.pickBest(v1better), ...L.pickBest(b)]);
  assert.equal(best.get("A").batch, "b1");
  assert.deepEqual(L.cutPoints([{ gloss: null, start: 0, end: 25 }, { gloss: "A", start: 16, end: 80 }, { gloss: null, start: 71, end: 96 }], 2), [{ gloss: "A", a: 6, b: 41 }]);
});

// ── state + names ─────────────────────────────────────────────────────────────
test("paid statuses, state file round trip, variant folder names", () => {
  for (const s of ["submitting", "submitted", "completed", "done", "rejected", "failed_after_submit"]) assert.ok(L.takeIsPaid({ status: s }), s);
  assert.ok(!L.takeIsPaid({ status: "planned" }));
  const d = tmp(), f = join(d, "s", "state.json");
  const s = L.newState("demo"); s.spent_usd = 3.2;
  L.saveState(f, s);
  assert.equal(L.loadState(f, "demo").spent_usd, 3.2);
  assert.throws(() => L.loadState(f, "library"), /state of set demo/);
  assert.equal(L.variantName("demo"), "demo");
  assert.equal(L.variantName("library", "ltx_r2r", "signer-bob"), "library-ltx_r2r-signer-bob");
  assert.throws(() => L.variantName("demo", "recast1080", "bob"), /avatar-model/);
  assert.deepEqual(L.v2Order(["clips-v2-library", "clips-v2-demo", "clips-v2-library-ltx_r2r", "clips-v2-sentences"]), ["clips-v2-demo", "clips-v2-sentences", "clips-v2-library"]);
});

// ── renderer export ───────────────────────────────────────────────────────────
test("renderer export: git archive of puppet/ at a ref, with RENDERER_SHA", async () => {
  const { exportRenderer, resolveRef, supportsPlacement } = await import("./renderer.mjs");
  const root = tmp();
  const r = exportRenderer({ repo: L.REPO, ref: "HEAD", root });
  assert.equal(r.sha, resolveRef(L.REPO, "HEAD"));
  assert.ok(existsSync(join(r.dir, "render.mjs")));
  assert.ok(existsSync(join(r.dir, "src", "blend.ts")));
  assert.equal(readFileSync(join(r.dir, "RENDERER_SHA"), "utf8").trim(), r.sha);
  assert.equal(typeof supportsPlacement(L.REPO, r.sha), "boolean");
  assert.throws(() => resolveRef(L.REPO, "no-such-branch-xyz"));
});

// ── finish (cut + even + manifest), on a tiny synthetic video ──────────────────
let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }
test("finish: cuts every 2nd frame, writes the manifest + aliases + sentence video, and is incremental", { skip: !hasFfmpeg && "no ffmpeg" }, async () => {
  const { finish } = await import("./finish.mjs");
  const d = tmp(), video = join(d, "take.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=96x128:rate=24", "-frames:v", "120", "-pix_fmt", "yuv420p", video]);
  const seg = [{ gloss: null, start: 0, end: 25 }, { gloss: "A", start: 16, end: 60 }, { gloss: null, start: 51, end: 76 }, { gloss: "B", start: 67, end: 100 }, { gloss: null, start: 91, end: 119 }];
  const cuts = L.cutPoints(seg, 2);
  const clips = cuts.map((c, k) => ({ id: ["A", "B"][k], gloss: c.gloss, video, source_video: "demo/b1/t0", a: c.a, b: c.b, every: 2,
    extra: { request_id: "r1", take: 0 }, aliases: k === 0 ? [{ id: "A2", gloss: "A2" }] : [] }));
  const spec = { final: join(d, "final"), raw: join(d, "raw"), inc: join(d, "inc"), target: join(d, "target.json"), clips,
    sentences: [{ id: "s01-a-b", video, source_video: "demo/b1/t0", every: 2, frames: 120, meta: { text: "A B" } }] };
  const log = () => {};
  const r1 = finish(spec, { log });
  const man = JSON.parse(readFileSync(join(d, "final", "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(man).sort(), ["A", "A2", "B"]);
  assert.equal(man.A.frames, cuts[0].b - cuts[0].a);
  assert.equal(man.A.every, 2);
  assert.equal(man.A.request_id, "r1");
  assert.equal(man.A2.alias_of, "A");
  assert.equal(man.A2.file, "A.mp4");
  const count = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", f]).toString().trim());
  assert.equal(count(join(d, "final", "A.mp4")), man.A.frames);
  assert.equal(count(join(d, "final", "sentences", "s01-a-b.mp4")), 60);
  assert.equal(JSON.parse(readFileSync(join(d, "final", "sentences.json"), "utf8"))[0].text, "A B");
  assert.ok(r1.changed.includes("A.mp4"));
  const r2 = finish(spec, { log });
  assert.equal(r2.jobs_processed, 0, "nothing changed: nothing re-cut");
  assert.deepEqual(r2.changed, ["sentences.json", "manifest.json"]);
  const r3 = finish({ ...spec, clips: [{ ...clips[0], b: clips[0].b - 2 }, clips[1]] }, { log });
  assert.equal(r3.jobs_processed, 1);
  assert.equal(JSON.parse(readFileSync(join(d, "final", "manifest.json"), "utf8")).A.frames, man.A.frames - 2);
  const r4 = finish({ ...spec, clips: [clips[1]], sentences: [] }, { log });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(d, "final", "manifest.json"), "utf8"))), ["B"], "stale entries dropped");
  assert.equal(r4.clips, 1);
});
