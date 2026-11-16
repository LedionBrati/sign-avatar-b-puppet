// The instant 3D signer's server side: {motion: true} plans, /motion/<stem>.json (slim, gzip, cache), /models/signer.glb.
//   node --test app/server/test/motion.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createApp } from "../index.mjs";
import { FACE_KEEP, slimMotion } from "../lib/motions.mjs";

const root = mkdtempSync(join(tmpdir(), "signlayer-motion-"));
const clipsDir = join(root, "clips"), v1Dir = join(root, "wlasl"), v2Dir = join(root, "wlasl3d"), model = join(root, "signer.glb");

const pts = (n, d, seed) => Array.from({ length: n }, (_, k) => Array.from({ length: d }, (_, j) => Math.round(((k * 31 + j * 7 + seed) % 97) / 97 * 1e4) / 1e4));
const frame = (i, extra = {}) => ({
  i, t: i / 25, pose: pts(33, 4, i), poseWorld: pts(33, 3, i + 1), face: pts(478, 3, i + 2),
  faceBlendshapes: { jawOpen: 0.1, eyeBlinkLeft: 0.2, cheekPuff: 0.3, browInnerUp: 0.4 },
  leftHand: null, leftHandWorld: null, rightHand: pts(21, 3, i + 3), rightHandWorld: pts(21, 3, i + 4), ...extra,
});
const motion = (name, motion_id, gloss, version = 1, frames = 10) => ({
  version, name, motion_id, gloss, source: { file: `videos/${name}.mp4`, dataset: "WLASL", license: "C-UDA (non-commercial)", signer: "1" },
  fps: 25, width: 640, height: 480, dominant_hand: "right", mirrored: false, extractor: { name: "test" }, cleaned: true,
  cleanup: { big: "x".repeat(500) },
  frames: Array.from({ length: frames }, (_, i) => frame(i, version === 2 ? { hands3d: { left: null, right: { joints: pts(21, 3, i), rot: pts(16, 4, i), conf: 0.8, src: "wilor", fit_mm: 9 } } } : {})),
});

before(() => {
  mkdirSync(clipsDir, { recursive: true });
  writeFileSync(join(clipsDir, "HELLO.mp4"), Buffer.alloc(100, 1));
  writeFileSync(join(clipsDir, "manifest.json"), JSON.stringify({ HELLO: { gloss: "HELLO", file: "HELLO.mp4", seconds: 1.2 } }));
  mkdirSync(v1Dir, { recursive: true });
  mkdirSync(join(v2Dir, "hands3d"), { recursive: true });
  writeFileSync(join(v1Dir, "hello-aaf4c6.clean.json"), JSON.stringify(motion("hello-aaf4c6", "HELLO", "HELLO")));
  writeFileSync(join(v1Dir, "thank_you-897a1c.clean.json"), JSON.stringify(motion("thank_you-897a1c", "THANK_YOU", "THANK YOU", 1, 40)));
  writeFileSync(join(v1Dir, "see-3d637f.clean.json"), JSON.stringify(motion("see-3d637f", "SEE", "SEE")));
  writeFileSync(join(v2Dir, "hands3d", "see-3d637f.v2.json"), JSON.stringify(motion("see-3d637f", "SEE", "SEE", 2)));
  writeFileSync(join(root, "neutral.clean.json"), JSON.stringify(motion("neutral", null, null, 1, 13)));
  writeFileSync(model, Buffer.from("glTF-fake-avatar"));
});

let app, base;
before(async () => {
  app = createApp({ clipsDirs: [clipsDir], semantic: false, recognizerUrl: "http://127.0.0.1:1", log: () => {},
    motion: { dirs: [v1Dir], v2Dirs: [v2Dir], rest: join(root, "neutral.clean.json"), model } });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); rmSync(root, { recursive: true, force: true }); });

const sign = async (body) => (await fetch(`${base}/api/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

test("health reports the 3D signer", async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(h.motion, { signs: 3, model: true, semantic: "off" });
  assert.equal(h.signs, 1); // clips only
});

test("without motion: a sign with motion but no clip stays caption-only (old clients unchanged)", async () => {
  const r = await sign({ text: "Hello, thank you" });
  assert.equal(r.safety.status, "caption_only");
  assert.deepEqual(r.playlist, []);
  assert.equal(r.rest_motion_url, undefined);
  const ok = await sign({ text: "hello" });
  assert.deepEqual(ok.playlist, [{ motion_id: "HELLO", gloss: "HELLO", url: "/clips/HELLO.mp4", duration_s: 1.2, word_index: 0 }]);
});

test("motion: true signs it; clip signs keep their url, motion-only signs have url \"\" and a motion_url", async () => {
  const r = await sign({ text: "Hello, thank you", motion: true });
  assert.equal(r.safety.status, "fully_supported");
  assert.deepEqual(r.playlist.map((p) => [p.motion_id, p.url, p.motion_url]), [
    ["HELLO", "/clips/HELLO.mp4", "/motion/hello-aaf4c6.json"],
    ["THANK_YOU", "", "/motion/thank_you-897a1c.json"],
  ]);
  assert.equal(r.rest_motion_url, "/motion/neutral.json");
});

test("motion: true still respects the safety gate for genuinely unsignable words", async () => {
  const r = await sign({ text: "thank you zyxwvut", motion: true });
  assert.equal(r.safety.status, "caption_only");
  assert.deepEqual(r.playlist, []);
  assert.ok([...r.unsupported, ...r.fingerspell].map((w) => w.toLowerCase()).includes("zyxwvut")); // a name to spell, and no letter motions

  const neg = await sign({ text: "not hello", motion: true });
  assert.notEqual(neg.safety.status, "fully_supported");
  const bad = await fetch(`${base}/api/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi", motion: "yes" }) });
  assert.equal(bad.status, 400);
});

test("GET /motion/<stem>.json: slim file, gzip, ETag, CORS, a day of caching", async () => {
  const res = await fetch(`${base}/motion/thank_you-897a1c.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("cache-control"), /max-age=86400/);
  assert.equal(res.headers.get("content-type"), "application/json");
  const m = await res.json(); // fetch undoes the gzip
  assert.equal(m.motion_id, "THANK_YOU");
  assert.deepEqual(m.face_subset, FACE_KEEP);
  assert.equal(m.frames.length, 40);
  assert.equal(m.frames[0].face.length, FACE_KEEP.length);
  assert.deepEqual(Object.keys(m.frames[0].faceBlendshapes).sort(), ["browInnerUp", "eyeBlinkLeft", "jawOpen"]);
  assert.equal(m.cleanup, undefined);
  const etag = res.headers.get("etag");
  assert.ok(etag);
  const again = await fetch(`${base}/motion/thank_you-897a1c.json`, { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
});

test("gzip only when asked; the v2 file wins over v1", async () => {
  const { request } = await import("node:http");
  const raw = (headers) => new Promise((resolve, reject) => {
    request(`${base}/motion/see-3d637f.json`, { headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
  const gz = await raw({ "accept-encoding": "gzip" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  const m = JSON.parse(gunzipSync(gz.body).toString("utf8"));
  assert.equal(m.version, 2);
  assert.equal(m.frames[0].hands3d.right.fit_mm, undefined);
  assert.equal(m.frames[0].hands3d.right.rot.length, 16);
  const plain = await raw({});
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(plain.body.toString("utf8")).version, 2);
  assert.ok(plain.body.length > gz.body.length);
});

test("GET /motion/neutral.json is the rest pose; unknown and traversal paths are 404", async () => {
  assert.equal((await fetch(`${base}/motion/neutral.json`)).status, 200);
  assert.equal((await fetch(`${base}/motion/nope.json`)).status, 404);
  assert.equal((await fetch(`${base}/motion/..%2F..%2Fsigner.glb`)).status, 404);
  assert.equal((await fetch(`${base}/motion/thank_you-897a1c.json`, { method: "POST" })).status, 405);
});

test("GET /models/signer.glb: the avatar, cacheable, CORS", async () => {
  const res = await fetch(`${base}/models/signer.glb`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "model/gltf-binary");
  assert.match(res.headers.get("cache-control"), /max-age=86400/);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "glTF-fake-avatar");
});

test("motion off: no routes, no motion field", async () => {
  const off = createApp({ clipsDirs: [clipsDir], semantic: false, recognizerUrl: "http://127.0.0.1:1", log: () => {}, motion: null });
  await new Promise((r) => off.server.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${off.server.address().port}`;
  try {
    assert.equal((await (await fetch(`${b}/api/health`)).json()).motion, undefined);
    assert.equal((await fetch(`${b}/models/signer.glb`)).status, 404);
    assert.equal((await fetch(`${b}/motion/hello-aaf4c6.json`)).status, 404);
    const r = await (await fetch(`${b}/api/sign`, { method: "POST", body: JSON.stringify({ text: "thank you", motion: true }) })).json();
    assert.equal(r.safety.status, "caption_only"); // a 3D client on an old/off server: captions, as before
  } finally { off.server.close(); }
});

test("slimMotion keeps the full face when a frame has no blendshapes (the player then solves the face from the mesh)", () => {
  const m = motion("x", "X", "X", 1, 3);
  delete m.frames[1].faceBlendshapes;
  const s = slimMotion(m);
  assert.equal(s.face_subset, undefined);
  assert.equal(s.frames[0].face.length, 478);
});
