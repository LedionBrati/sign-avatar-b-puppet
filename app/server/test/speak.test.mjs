// POST /api/speak with a FAKE OpenAI client (no network, no key).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../index.mjs";
import { MAX_SPEAK_CHARS, createSpeaker } from "../lib/speak.mjs";

const root = mkdtempSync(join(tmpdir(), "signlayer-speak-test-"));
const clipsDir = join(root, "clips");
mkdirSync(clipsDir);
writeFileSync(join(clipsDir, "HELLO.mp4"), "synthetic fixture; not ASL");
writeFileSync(join(clipsDir, "manifest.json"), JSON.stringify({ HELLO: { gloss: "HELLO", file: "HELLO.mp4", seconds: 0.5 } }));
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const post = (base, body) => fetch(`${base}/api/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const FAKE_MP3 = Buffer.from([0xff, 0xf3, 0x44, 0xc4, 1, 2, 3, 4]);
const SECRET = "sk-test-not-a-real-key-123456";

let calls, logs, app, base, appOff, baseOff;
before(async () => {
  calls = [];
  logs = [];
  const client = { audio: { speech: { async create(p) {
    calls.push(p);
    if (p.input.includes("boom")) throw Object.assign(new Error(`upstream down for ${SECRET}`), { status: 500 });
    return { arrayBuffer: async () => FAKE_MP3.buffer.slice(FAKE_MP3.byteOffset, FAKE_MP3.byteOffset + FAKE_MP3.length) };
  } } } };
  const speaker = createSpeaker({ client, model: "fake-tts", secrets: [SECRET] });
  app = createApp({ clipsDirs: [clipsDir], semantic: false, agent: null, transcriber: null, composer: null, speaker, recognizerUrl: "http://127.0.0.1:1", log: (l) => logs.push(l) });
  base = await listen(app.server);
  appOff = createApp({ clipsDirs: [clipsDir], semantic: false, agent: null, transcriber: null, composer: null, speaker: null, recognizerUrl: "http://127.0.0.1:1", log: () => {} });
  baseOff = await listen(appOff.server);
});
after(() => { app.server.close(); appOff.server.close(); rmSync(root, { recursive: true, force: true }); });

test("speak: text -> audio/mpeg from the TTS model with the default voice", async () => {
  const r = await post(base, { text: "  I'm   hungry. " });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), FAKE_MP3);
  const p = calls.at(-1);
  assert.equal(p.input, "I'm hungry.");
  assert.equal(p.voice, "coral");
  assert.equal(p.model, "fake-tts");
  assert.equal(p.response_format, "mp3");
  assert.equal((await (await fetch(`${base}/api/health`)).json()).speak, "ready");
});

test("speak: repeated text is served from the cache; a voice choice is honoured", async () => {
  const n = calls.length;
  const a = await post(base, { text: "Thank you!" });
  const b = await post(base, { text: "Thank you!" });
  assert.equal(a.headers.get("x-speak-cached"), "0");
  assert.equal(b.headers.get("x-speak-cached"), "1");
  assert.equal(calls.length, n + 1);
  assert.equal((await post(base, { text: "Thank you!", voice: "nova" })).status, 200);
  assert.equal(calls.at(-1).voice, "nova");
});

test("speak: bad bodies are 400/413, upstream failure is 502 without leaking key or text, no key is 503", async () => {
  assert.equal((await post(base, { text: "" })).status, 400);
  assert.equal((await post(base, { nope: 1 })).status, 400);
  assert.equal((await post(base, { text: "hi", voice: "robot" })).status, 400);
  assert.equal((await post(base, { text: "a".repeat(MAX_SPEAK_CHARS + 1) })).status, 413);
  assert.equal((await fetch(`${base}/api/speak`)).status, 405);
  const bad = await post(base, { text: "boom private words" });
  assert.equal(bad.status, 502);
  assert.equal((await bad.json()).error.code, "speak_failed");
  assert.ok(logs.length > 0);
  for (const l of logs) { assert.ok(!l.includes(SECRET)); assert.ok(!l.includes("private words")); }
  const off = await post(baseOff, { text: "hi" });
  assert.equal(off.status, 503);
  assert.equal((await off.json()).error.code, "speak_off");
  assert.equal((await (await fetch(`${baseOff}/api/health`)).json()).speak, "off");
});
