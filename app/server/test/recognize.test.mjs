// POST /api/recognize proxy (against a fake recognizer) and the static /app/ web build.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, MAX_RECOGNIZE_BODY } from "../index.mjs";

const root = mkdtempSync(join(tmpdir(), "flux-rec-"));
const clipsDir = join(root, "clips");
const dist = join(root, "dist");
mkdirSync(clipsDir);
writeFileSync(join(clipsDir, "manifest.json"), "{}");
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><title>Flux</title>");
writeFileSync(join(dist, "assets", "app-123.js"), "console.log('hi')");
writeFileSync(join(root, "secret.txt"), "outside dist");

const FRAME_BYTES = 543 * 3 * 4;
const seen = [];
let fake, fakeUrl, app, base, appDown, baseDown, appNoDist, baseNoDist;

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  // Fake recognizer: records what arrives, answers like app/recognizer.
  fake = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://x");
      seen.push({ method: req.method, path: url.pathname, mode: url.searchParams.get("mode"), frames: req.headers["x-frames"], bytes: body.length, first: body.length ? body.readFloatLE(0) : null, q: Object.fromEntries(url.searchParams), fps: req.headers["x-fps"] });
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/health") return res.end(JSON.stringify({ ok: true }));
      if (url.pathname === "/enroll" || url.pathname === "/train" || url.pathname === "/profiles") return res.end(JSON.stringify({ profile: url.searchParams.get("profile"), reps: { HELLO: 1 }, trained: url.pathname === "/train" }));
      const frames = Number(req.headers["x-frames"]);
      if (body.length !== frames * FRAME_BYTES) { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: "bad_body_size", message: "size" } })); }
      const mode = url.searchParams.get("mode");
      res.end(JSON.stringify(mode === "spell"
        ? { mode, options: [], text: "MARIA", frames, timings: { inference_ms: 1, total_ms: 2 } }
        : { mode, options: [{ label: "thankyou", text: "thank you", confidence: 0.9 }], frames, timings: { inference_ms: 1, total_ms: 2 } }));
    });
  });
  fakeUrl = await listen(fake);
  app = createApp({ clipsDirs: [clipsDir], semantic: false, recognizerUrl: fakeUrl, webDist: dist, log: () => {} });
  base = await listen(app.server);
  appDown = createApp({ clipsDirs: [clipsDir], semantic: false, recognizerUrl: "http://127.0.0.1:1", webDist: dist, log: () => {} });
  baseDown = await listen(appDown.server);
  appNoDist = createApp({ clipsDirs: [clipsDir], semantic: false, recognizerUrl: fakeUrl, webDist: join(root, "nope"), log: () => {} });
  baseNoDist = await listen(appNoDist.server);
});
after(() => { for (const s of [fake, app?.server, appDown?.server, appNoDist?.server]) s?.close(); rmSync(root, { recursive: true, force: true }); });

const segment = (frames) => {
  const a = new Float32Array(frames * 543 * 3).fill(NaN);
  a[0] = 0.25;
  return Buffer.from(a.buffer);
};
const recognize = (b, mode, frames, body = segment(frames)) =>
  fetch(`${b}/api/recognize${mode ? `?mode=${mode}` : ""}`, { method: "POST", headers: { "content-type": "application/octet-stream", "X-Frames": String(frames) }, body });

test("health reports the recognizer ready / down", async () => {
  assert.equal((await (await fetch(`${base}/api/health`)).json()).recognizer, "ready");
  assert.equal((await (await fetch(`${baseDown}/api/health`)).json()).recognizer, "down");
});

test("proxy: sign and spell pass body, X-Frames and mode through", async () => {
  seen.length = 0;
  let res = await recognize(base, "sign", 12);
  assert.equal(res.status, 200);
  let out = await res.json();
  assert.equal(out.mode, "sign");
  assert.deepEqual(out.options[0], { label: "thankyou", text: "thank you", confidence: 0.9 });
  assert.deepEqual(seen.at(-1), { method: "POST", path: "/recognize", mode: "sign", frames: "12", bytes: 12 * FRAME_BYTES, first: 0.25, q: { mode: "sign" }, fps: undefined });
  res = await recognize(base, "spell", 3);
  out = await res.json();
  assert.equal(out.text, "MARIA");
  assert.equal(seen.at(-1).mode, "spell");
  res = await recognize(base, undefined, 2);
  assert.equal((await res.json()).mode, "sign"); // default mode
});

test("proxy: closed vocabulary (profile, vocab, X-Fps) and Train my signs routes", async () => {
  seen.length = 0;
  let res = await fetch(`${base}/api/recognize?mode=sign&profile=me&vocab=HELLO,YES&junk=1`, { method: "POST", headers: { "content-type": "application/octet-stream", "X-Frames": "4", "X-Fps": "24.5" }, body: segment(4) });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.at(-1).q, { mode: "sign", profile: "me", vocab: "HELLO,YES" });
  assert.equal(seen.at(-1).fps, "24.5");
  res = await fetch(`${base}/api/enroll?profile=me&label=HELLO`, { method: "POST", headers: { "content-type": "application/octet-stream", "X-Frames": "3" }, body: segment(3) });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.at(-1), { method: "POST", path: "/enroll", mode: null, frames: "3", bytes: 3 * FRAME_BYTES, first: 0.25, q: { profile: "me", label: "HELLO" }, fps: undefined });
  assert.equal((await (await fetch(`${base}/api/enroll?profile=me`)).json()).reps.HELLO, 1);
  assert.equal((await (await fetch(`${base}/api/train?profile=me`, { method: "POST", body: "{}" })).json()).trained, true);
  assert.equal(seen.at(-1).path, "/train");
  res = await fetch(`${base}/api/enroll?profile=me&label=HELLO`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal(seen.at(-1).method, "DELETE");
  assert.equal((await fetch(`${base}/api/enroll?profile=me`, { method: "POST", body: segment(1) })).status, 400); // no X-Frames
  assert.equal((await fetch(`${base}/api/train`)).status, 405);
  assert.equal((await fetch(`${baseDown}/api/enroll?profile=me`)).status, 503);
});

test("proxy: upstream errors are passed through, local validation first", async () => {
  let res = await recognize(base, "sign", 3, segment(2));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "bad_body_size");
  const before = seen.length;
  res = await recognize(base, "dance", 1);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "bad_mode");
  res = await fetch(`${base}/api/recognize?mode=sign`, { method: "POST", body: segment(1) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "bad_frames");
  res = await fetch(`${base}/api/recognize?mode=sign`, { method: "POST", headers: { "X-Frames": "385" }, body: Buffer.alloc(MAX_RECOGNIZE_BODY + FRAME_BYTES) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, "too_many_frames");
  assert.equal((await fetch(`${base}/api/recognize`)).status, 405);
  assert.equal(seen.length, before); // none of these reached the recognizer
});

test("proxy: recognizer down -> 503 JSON", async () => {
  const res = await recognize(baseDown, "sign", 4);
  assert.equal(res.status, 503);
  const out = await res.json();
  assert.equal(out.error.code, "recognizer_down");
  assert.match(out.error.message, /recognizer/);
});

test("CORS preflight allows X-Frames", async () => {
  const res = await fetch(`${base}/api/recognize?mode=sign`, { method: "OPTIONS", headers: { origin: "http://phone", "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-frames" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers"), /x-frames/);
});

test("/app/ serves the web build with SPA fallback", async () => {
  let res = await fetch(`${base}/app/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /Flux/);
  res = await fetch(`${base}/app/assets/app-123.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  assert.match(res.headers.get("cache-control"), /immutable/);
  res = await fetch(`${base}/app/sign/deep/route`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Flux/);
  assert.equal((await fetch(`${base}/app/assets/missing.js`)).status, 404);
  assert.equal((await fetch(`${base}/app/..%2Fsecret.txt`)).status, 404);
  res = await fetch(`${base}/app`, { redirect: "manual" });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/app/");
});

test("/app/ without a build -> 404 with a helpful message", async () => {
  const res = await fetch(`${baseNoDist}/app/`);
  assert.equal(res.status, 404);
  const out = await res.json();
  assert.equal(out.error.code, "no_web_build");
  assert.match(out.error.message, /npm run build/);
});
