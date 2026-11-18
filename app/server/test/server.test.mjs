// node --test app/server/test/   (fixture clip dirs in a temp folder; the semantic test uses the cached local model)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../index.mjs";

const SIGNS = { HELLO: "HELLO", MY: "MY", NAME: "NAME", THANK_YOU: "THANK YOU", SEE: "SEE", YOU: "YOU", LATER: "LATER", WHERE: "WHERE", HURT: "HURT" };
const root = mkdtempSync(join(tmpdir(), "flux-test-"));
const dirA = join(root, "clips"), dirB = join(root, "vocab-1");
// Deterministic fake "mp4" bytes: byte i = (i * 7 + seed) & 255.
const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255));
const CLIP = bytes(5000, 1);

function writeSet(dir, entries) {
  mkdirSync(dir, { recursive: true });
  const manifest = {};
  for (const [id, gloss, data, seconds] of entries) {
    writeFileSync(join(dir, `${id}.mp4`), data);
    manifest[id] = { gloss, file: `${id}.mp4`, frames: Math.round(seconds * 24), seconds };
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}
writeSet(dirA, Object.entries(SIGNS).map(([id, g], i) => [id, g, id === "HELLO" ? CLIP : bytes(300, i), 1 + i / 10]));
writeSet(dirB, [["HELLO", "HELLO", bytes(10, 99), 9], ["GOOD", "GOOD", bytes(400, 5), 1.25]]);
mkdirSync(join(root, "empty"));
// A manifest entry whose file is missing must never be offered.
writeFileSync(join(dirB, "manifest.json"), JSON.stringify({
  HELLO: { gloss: "HELLO", file: "HELLO.mp4", seconds: 9 }, GOOD: { gloss: "GOOD", file: "GOOD.mp4", seconds: 1.25 },
  GHOST: { gloss: "GHOST", file: "GHOST.mp4", seconds: 1 },
}));

let app, base;
const logs = [];
before(async () => {
  // recognizerUrl: a closed port, so health reports the recognizer as down (recognize.test.mjs covers the proxy).
  app = createApp({ clipsDirs: [dirA, dirB, join(root, "empty")], semantic: false, recognizerUrl: "http://127.0.0.1:1", log: (l) => logs.push(l) });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.close(); rmSync(root, { recursive: true, force: true }); });

const sign = async (body, raw) => {
  const res = await fetch(`${base}/api/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
  return { status: res.status, body: await res.json(), headers: res.headers };
};
const ids = (r) => r.playlist.map((p) => p.motion_id).join(" ");

test("health", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, signs: 10, semantic: "off", agent: "off", transcribe: "off", compose: "off", speak: "off", recognizer: "down" });
});

test("vocab merges dirs, first dir wins, missing files skipped", async () => {
  const { signs } = await (await fetch(`${base}/api/vocab`)).json();
  assert.deepEqual(signs.map((s) => s.motion_id), [...Object.keys(SIGNS), "GOOD"]);
  assert.equal(signs.find((s) => s.motion_id === "HELLO").duration_s, 1);
  assert.deepEqual(signs.find((s) => s.motion_id === "THANK_YOU"), { motion_id: "THANK_YOU", gloss: "THANK YOU", duration_s: 1.3 });
  assert.ok(logs.some((l) => l.includes("GHOST")));
});

test("Thank you, see you later. -> THANK_YOU SEE YOU LATER with word indexes", async () => {
  const { status, body } = await sign({ text: "Thank you, see you later." });
  assert.equal(status, 200);
  assert.deepEqual(body.words, ["Thank", "you,", "see", "you", "later."]);
  assert.equal(ids(body), "THANK_YOU SEE YOU LATER");
  assert.deepEqual(body.playlist.map((p) => p.word_index), [0, 2, 3, 4]);
  assert.deepEqual(body.playlist[0], { motion_id: "THANK_YOU", gloss: "THANK YOU", url: "/clips/THANK_YOU.mp4", duration_s: 1.3, word_index: 0 });
  assert.deepEqual(body.unsupported, []);
  assert.deepEqual(body.markers, []);
  assert.equal(body.plan.ok, true);
  assert.ok(body.timings.translate_ms >= 0 && body.timings.total_ms >= body.timings.translate_ms);
});

test("Where does it hurt? -> HURT WHERE + question_wh marker over both", async () => {
  const { body } = await sign({ text: "Where does it hurt?", semantic: false });
  assert.equal(ids(body), "HURT WHERE");
  assert.deepEqual(body.playlist.map((p) => body.words[p.word_index]), ["hurt?", "Where"]);
  assert.deepEqual(body.markers, [{ type: "question_wh", from: 0, to: 1 }]);
});

test("names without letter clips block the entire playlist", async () => {
  const { body } = await sign({ text: "Hello, my name is Maria. Do you see?" });
  assert.equal(ids(body), "");
  assert.deepEqual(body.fingerspell, ["MARIA"]);
  assert.deepEqual(body.markers, []);
  assert.equal(body.safety.status, "caption_only");
  assert.ok(body.safety.reasons.some((r) => r.code === "missing_fingerspelling"));
});

test("unknown words -> unsupported, never invented; nothing signable -> empty playlist", async () => {
  let { status, body } = await sign({ text: "I see the giraffe later" });
  assert.equal(status, 200);
  assert.equal(ids(body), "");
  assert.deepEqual(body.unsupported, ["I", "giraffe"]);
  assert.equal(body.safety.status, "caption_only");
  ({ body } = await sign({ text: "Xylophone." }));
  assert.deepEqual(body.playlist, []);
  assert.deepEqual(body.unsupported, ["Xylophone"]);
});

test("bad input -> JSON errors, server keeps running", async () => {
  const cases = [
    [{ text: "" }, 400, "empty_text"], [{ text: "   " }, 400, "empty_text"], [{}, 400, "bad_text"],
    [{ text: 42 }, 400, "bad_text"], [{ text: "x".repeat(501) }, 413, "text_too_long"],
    [{ text: "hi", semantic: "yes" }, 400, "bad_semantic"], [[1, 2], 400, "bad_request"], [null, 400, "bad_request"],
  ];
  for (const [body, status, code] of cases) {
    const r = await sign(body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.body.error.code, code);
    assert.equal(typeof r.body.error.message, "string");
  }
  assert.equal((await sign(null, "{not json")).body.error.code, "bad_json");
  assert.equal((await sign(null, "")).body.error.code, "empty_body");
  assert.equal((await sign({ text: "x".repeat(500) })).status, 200);
  const big = await sign(null, JSON.stringify({ text: "a ".repeat(20000) }));
  assert.equal(big.status, 413);
  const get = await fetch(`${base}/api/sign`);
  assert.equal(get.status, 405);
  assert.equal((await (await fetch(`${base}/nope`)).json()).error.code, "not_found");
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("CORS: any origin, preflight, private network access", async () => {
  const res = await fetch(`${base}/api/sign`, { method: "OPTIONS", headers: {
    origin: "chrome-extension://abcdef", "access-control-request-method": "POST",
    "access-control-request-headers": "content-type", "access-control-request-private-network": "true" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods"), /POST/);
  assert.equal(res.headers.get("access-control-allow-headers"), "content-type");
  assert.equal(res.headers.get("access-control-allow-private-network"), "true");
  const { headers } = await sign({ text: "Hello" });
  assert.equal(headers.get("access-control-allow-origin"), "*");
});

test("clips: full file, Range 206 with correct bytes, suffix range, 416, HEAD, 304", async () => {
  const url = `${base}/clips/HELLO.mp4`;
  let res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.match(res.headers.get("cache-control"), /max-age/);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(CLIP));
  const etag = res.headers.get("etag");

  res = await fetch(url, { headers: { range: "bytes=100-1099" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 100-1099/5000");
  assert.equal(res.headers.get("content-length"), "1000");
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(CLIP.subarray(100, 1100)));

  res = await fetch(url, { headers: { range: "bytes=0-1" } });           // Safari's first probe
  assert.equal(res.status, 206);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(CLIP.subarray(0, 2)));

  res = await fetch(url, { headers: { range: "bytes=4900-" } });
  assert.equal(res.headers.get("content-range"), "bytes 4900-4999/5000");
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(CLIP.subarray(4900)));

  res = await fetch(url, { headers: { range: "bytes=-10" } });
  assert.equal(res.status, 206);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(CLIP.subarray(4990)));

  res = await fetch(url, { headers: { range: "bytes=5000-6000" } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get("content-range"), "bytes */5000");

  res = await fetch(url, { method: "HEAD" });
  assert.equal(res.headers.get("content-length"), "5000");
  res = await fetch(url, { headers: { "if-none-match": etag } });
  assert.equal(res.status, 304);
});

test("clips: second dir served under its own name, conflicts namespaced, nothing outside manifests", async () => {
  const good = await fetch(`${base}/clips/GOOD.mp4`);
  assert.equal(good.status, 200);
  assert.ok(Buffer.from(await good.arrayBuffer()).equals(bytes(400, 5)));
  for (const p of ["/clips/manifest.json", "/clips/GHOST.mp4", "/clips/..%2F..%2Fetc%2Fpasswd", "/clips/%E0%A4%A", "/clips/1/HELLO.mp4"]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
    assert.equal((await res.json()).error.code, "no_clip");
  }
});

test("semantic layer (local model): pain -> HURT once ready; rules-only until then", { timeout: 120_000 }, async (t) => {
  const s = createApp({ clipsDirs: [dirA], log: () => {} });
  assert.equal(s.state.semantic, "loading");
  const early = await s.sign({ text: "Where is the pain?" });
  assert.equal(ids(early), "");                                     // unsupported pain blocks the prefix
  if (!(await s.ready)) return t.skip("semantic model unavailable offline");
  assert.equal(s.state.semantic, "ready");
  const warm = await s.sign({ text: "Where is the pain?" });
  assert.equal(ids(warm), "");
  assert.equal(warm.safety.status, "needs_confirmation");
  assert.ok(warm.safety.reasons.some((r) => r.code === "semantic_uncertainty"));
  assert.equal(ids(await s.sign({ text: "Where is the pain?", semantic: false })), "");
});
