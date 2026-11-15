// node --test app/server/test/ondemand.test.mjs
// Generate-on-use with fake pipeline steps (no Chrome, no fal, no ffmpeg): queue dedupe, budget refusal,
// frame-count mismatch -> failed after one retry, hot reload makes the sign playable, the fal key never leaks.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../index.mjs";
import { childEnv, reserveUsd, scanMotionDirs } from "../lib/ondemand.mjs";

const root = mkdtempSync(join(tmpdir(), "signlayer-ondemand-"));
after(() => rmSync(root, { recursive: true, force: true }));

// Clips: I, FEEL, WANT. Motion only: SICK (1 s), WATER (1 s), HOSPITAL (4 s), DOCTOR (QC fail), plus a clip sign's motion.
const clipsDir = join(root, "clips");
mkdirSync(clipsDir);
const manifest = {};
for (const [id, gloss] of [["I", "I"], ["FEEL", "FEEL"], ["WANT", "WANT"]]) {
  writeFileSync(join(clipsDir, `${id}.mp4`), Buffer.alloc(100, 1));
  manifest[id] = { gloss, file: `${id}.mp4`, frames: 30, seconds: 1.25 };
}
writeFileSync(join(clipsDir, "manifest.json"), JSON.stringify(manifest));

const motionDir = join(root, "motion");
mkdirSync(motionDir);
const motion = (name, id, gloss, frames) => writeFileSync(join(motionDir, `${name}.clean.json`),
  JSON.stringify({ version: 1, name, motion_id: id, gloss, fps: 25, frames: Array.from({ length: frames }, (_, i) => ({ i, t: i / 25 })) }));
motion("sick-aaaaaa", "SICK", "sick", 25);
motion("water-bbbbbb", "WATER", "water", 25);
motion("hospital-cccccc", "HOSPITAL", "hospital", 100);
motion("doctor-dddddd", "DOCTOR", "doctor", 25);
motion("feel-eeeeee", "FEEL", "feel", 25);
writeFileSync(join(motionDir, "summary.csv"), [
  "gloss,motion_id,name,fps,dominant_hand_pct_clean,trimmed_frames,error",
  "sick,SICK,sick-aaaaaa,25,91.9,25,", "water,WATER,water-bbbbbb,25,88.6,25,", "hospital,HOSPITAL,hospital-cccccc,25,95,100,",
  "doctor,DOCTOR,doctor-dddddd,25,72.1,25,", "feel,FEEL,feel-eeeeee,25,100,25,",
].join("\n"));
const neutral = join(root, "neutral.clean.json");
writeFileSync(neutral, JSON.stringify({ name: "neutral", motion_id: "NEUTRAL", gloss: null, fps: 24, frames: [] }));

const FAKE_KEY = "a1b2c3d4-0000-4e5f-9a8b-c0ffee123456:5ecret5ecret5ecret5ecret";

/** Fake compose/render/recast/probe/cut. compose lays out NEUTRAL(13) S(30) NEUTRAL(13) ..., padded to >= 121 frames. */
function fakes({ recastFrames = (n) => n, recastError = null, gate = null } = {}) {
  const frames = new Map();
  const calls = { compose: 0, render: 0, recast: 0, cut: 0 };
  return {
    calls,
    steps: {
      async compose({ signs, out }) {
        calls.compose++;
        const segments = [];
        let f = 0;
        const push = (gloss, n) => { segments.push({ gloss, start: f, end: f + n - 1 }); f += n; };
        push(null, 13);
        for (const s of signs) { push(s.motion_id.replace(/_/g, " "), 30); push(null, 13); }
        if (f < 121) { segments.at(-1).end += 121 - f; f = 121; }
        writeFileSync(out, JSON.stringify({ frames: f }));
        return { frames: f, seconds: (f - 1) / 24, segments };
      },
      async render({ motion: m, out }) {
        calls.render++;
        if (gate) await gate.promise;
        writeFileSync(out, "puppet");
        frames.set(out, JSON.parse(readFileSync(m, "utf8")).frames);
      },
      async recast({ video, out }) {
        calls.recast++;
        if (recastError) throw recastError();
        writeFileSync(out, "generated");
        frames.set(out, recastFrames(frames.get(video)));
        return { request_id: `req-${calls.recast}`, fal_s: 1 };
      },
      async probeFrames(file) { return frames.get(file); },
      async cut({ segments, outDir, signs, extra }) {
        calls.cut++;
        const mp = join(outDir, "manifest.json");
        const man = existsSync(mp) ? JSON.parse(readFileSync(mp, "utf8")) : {};
        assert.equal(segments.filter((s) => s.gloss).length, signs.length);
        for (const s of signs) {
          writeFileSync(join(outDir, `${s.id}.mp4`), Buffer.alloc(64, 7));
          man[s.id] = { gloss: s.gloss, file: `${s.id}.mp4`, frames: 43, seconds: 1.792, ...extra };
        }
        writeFileSync(mp, JSON.stringify(man));
        return signs;
      },
    },
  };
}

let n = 0;
async function start({ budgetUsd = 20, maxQueue = 30, falKey, ...f } = {}) {
  const dir = join(root, `run-${++n}`);
  const fk = fakes(f);
  const logs = [];
  const app = createApp({
    clipsDirs: [clipsDir], semantic: false, agent: null, recognizerUrl: "http://127.0.0.1:1", log: (l) => logs.push(l),
    ondemand: { motionDirs: [motionDir], neutral, avatar: join(root, "avatar.jpg"), stateDir: join(dir, "state"), clipsDir: join(dir, "clips-ondemand"),
      budgetUsd, maxQueue, gatherMs: 5, steps: fk.steps, ...(falKey ? { falKey } : {}) },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sign = async (text) => (await fetch(`${base}/api/sign`, { method: "POST", body: JSON.stringify({ text }) })).json();
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  return { app, base, sign, get, logs, calls: fk.calls, dir, close: () => app.server.close() };
}

test("off unless configured: no ondemand in health, no generating, status says disabled", async () => {
  const app = createApp({ clipsDirs: [clipsDir], semantic: false, agent: null, recognizerUrl: "http://127.0.0.1:1", log: () => {} });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal("ondemand" in health, false);
    const r = await (await fetch(`${base}/api/sign`, { method: "POST", body: JSON.stringify({ text: "I feel sick" }) })).json();
    assert.equal(r.safety.status, "caption_only");
    assert.equal(r.generating, undefined);
    assert.equal((await (await fetch(`${base}/api/ondemand`)).json()).enabled, false);
  } finally { app.server.close(); }
});

test("motion index: QC failures and summary errors are left out", () => {
  const index = scanMotionDirs([motionDir]);
  assert.deepEqual([...index.keys()].sort(), ["FEEL", "HOSPITAL", "SICK", "WATER"]);
  assert.equal(index.get("SICK").gloss, "SICK");
  assert.equal(index.get("HOSPITAL").seconds, 4);
});

test("queue dedupe, current request not delayed, then hot reload makes the sign playable", async () => {
  let release;
  const gate = { promise: new Promise((r) => { release = r; }) };
  const s = await start({ gate });
  try {
    const first = await s.sign("I feel sick");
    assert.equal(first.safety.status, "caption_only");                 // captions only now, never a partial playlist
    assert.deepEqual(first.playlist, []);
    assert.deepEqual(first.unsupported, ["sick"]);
    assert.equal(first.generating.length, 1);
    assert.equal(first.generating[0].motion_id, "SICK");
    assert.equal(first.generating[0].gloss, "SICK");
    assert.ok(first.generating[0].eta_s > 0);

    const again = await s.sign("i FEEL sick!");                          // same sign: no second queue entry
    assert.deepEqual(again.generating.map((g) => g.motion_id), ["SICK"]);
    const purple = await s.sign("I feel purple");                         // no motion at all: plain unsupported
    assert.equal(purple.generating, undefined);
    assert.deepEqual(purple.unsupported, ["purple"]);

    const st = await s.get("/api/ondemand");
    assert.equal(st.items.length, 1);
    assert.equal(st.queued + st.running, 1);
    const health = await s.get("/api/health");
    assert.deepEqual(Object.keys(health.ondemand).sort(), ["done_today", "enabled", "queued", "running", "spent_today_est"]);
    assert.equal(health.ondemand.enabled, true);

    release();
    await s.app.ondemand.idle();
    assert.deepEqual(s.calls, { compose: 1, render: 1, recast: 1, cut: 1 });

    const now = await s.sign("I feel sick");                              // no restart: the new clip is in the library
    assert.equal(now.safety.status, "fully_supported");
    assert.deepEqual(now.playlist.map((p) => p.motion_id), ["I", "FEEL", "SICK"]);
    assert.equal(now.generating, undefined);
    const clip = await fetch(`${s.base}${now.playlist[2].url}`);
    assert.equal(clip.status, 200);
    assert.equal((await clip.arrayBuffer()).byteLength, 64);
    assert.ok((await s.get("/api/vocab")).signs.some((x) => x.motion_id === "SICK"));

    const done = await s.get("/api/ondemand");
    assert.equal(done.done_today, 1);
    assert.equal(done.items[0].status, "done");
    const batch = done.batches[0];
    assert.equal(batch.status, "done");
    assert.deepEqual(batch.signs, ["SICK"]);
    assert.equal(batch.frames, 121);                                     // padded to Recast's 5 s minimum
    assert.equal(batch.reserve_usd, reserveUsd(121 / 24));
    assert.deepEqual(Object.keys(batch.timings_s), ["compose", "render", "fal", "cut", "reload"]);
    assert.equal(done.spent_today_est, reserveUsd(121 / 24));
    // State survives a restart (persistent JSON).
    const saved = JSON.parse(readFileSync(join(s.dir, "state", "state.json"), "utf8"));
    assert.equal(saved.items.SICK.status, "done");
  } finally { s.close(); }
});

test("signs from one sentence share a batch; max queue is respected", async () => {
  const s = await start({ maxQueue: 2 });
  try {
    const r = await s.sign("I want water, I feel sick, hospital");
    assert.deepEqual(r.generating.map((g) => g.motion_id).sort(), ["SICK", "WATER"]);   // HOSPITAL: queue full
    await s.app.ondemand.idle();
    assert.equal(s.calls.recast, 1);
    assert.deepEqual((await s.get("/api/ondemand")).batches[0].signs.sort(), ["SICK", "WATER"]);
  } finally { s.close(); }
});

test("budget: nothing queued when even a 5 s batch does not fit; a batch over the budget is refused, never paid", async () => {
  const tiny = await start({ budgetUsd: 1 });
  try {
    const r = await tiny.sign("I feel sick");
    assert.equal(r.generating, undefined);
    assert.equal((await tiny.get("/api/ondemand")).queued, 0);
  } finally { tiny.close(); }

  const s = await start({ budgetUsd: 1.5 });                            // 1 s sign fits (5 s = $1.25); 4 s HOSPITAL + SICK do not
  try {
    const r = await s.sign("I feel sick, hospital");
    assert.deepEqual(r.generating.map((g) => g.motion_id).sort(), ["HOSPITAL", "SICK"]);
    await s.app.ondemand.idle();
    assert.equal(s.calls.recast, 0);
    assert.equal(s.calls.render, 0);
    const st = await s.get("/api/ondemand");
    assert.equal(st.spent_today_est, 0);
    assert.equal(st.batches[0].status, "refused");
    assert.ok(st.items.every((it) => it.status === "failed" && it.code === "daily_budget"));
    assert.match(st.items[0].reason, /daily budget/);
  } finally { s.close(); }
});

test("output frames != input frames -> failed after one retry, never cut, server keeps working", async () => {
  const s = await start({ recastFrames: (n) => n + 1 });
  try {
    await s.sign("I feel sick");
    await s.app.ondemand.idle();
    assert.equal(s.calls.recast, 2);                                     // first try + one retry
    assert.equal(s.calls.cut, 0);
    const st = await s.get("/api/ondemand");
    const it = st.items.find((x) => x.motion_id === "SICK");
    assert.equal(it.status, "failed");
    assert.equal(it.code, "frames_mismatch");
    assert.equal(it.attempts, 2);
    assert.match(it.reason, /122 frames, expected 121/);
    assert.equal(st.batches.length, 2);
    const later = await s.sign("I feel sick");                           // gave up: caption only, not re-queued
    assert.equal(later.safety.status, "caption_only");
    assert.equal(later.generating, undefined);
    assert.equal((await s.get("/api/health")).ok, true);
  } finally { s.close(); }
});

test("the fal key never appears in errors, status, state or logs; child processes never get it", async () => {
  const prev = process.env.FAL_KEY;
  const s = await start({ falKey: FAKE_KEY, recastError: () => new Error(`401 Unauthorized: invalid key ${FAKE_KEY} (Authorization: Key ${FAKE_KEY})`) });
  try {
    await s.sign("I feel sick");
    await s.app.ondemand.idle();
    const body = await (await fetch(`${s.base}/api/ondemand`)).text();
    assert.ok(!body.includes(FAKE_KEY));
    assert.ok(!body.includes("5ecret5ecret"));
    assert.match(body, /\[redacted\]/);
    const state = readFileSync(join(s.dir, "state", "state.json"), "utf8");
    assert.ok(!state.includes(FAKE_KEY) && !state.includes("5ecret5ecret"));
    assert.ok(s.logs.length > 0);
    assert.ok(s.logs.every((l) => !l.includes(FAKE_KEY) && !l.includes("5ecret5ecret")));
    assert.ok(s.logs.some((l) => l.includes("failed (failed)") || l.includes("[redacted]")));
    const env = childEnv({ PATH: "p", FAL_KEY: FAKE_KEY, FAL_KEY_FILE: "C:/k.txt", OPENAI_API_KEY: "sk-x", OPENAI_API_KEY_FILE: "f" });
    assert.deepEqual(env, { PATH: "p" });
  } finally {
    s.close();
    if (prev === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = prev;
  }
});
