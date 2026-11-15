// POST /api/transcribe with a FAKE OpenAI client (no network, no key). Synthetic audio bytes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../index.mjs";
import { createTranscriber, MAX_AUDIO_BYTES } from "../lib/transcribe.mjs";

const FAKE_KEY = "sk-proj-FAKEfakeFAKEfake0123456789abcdefABCDEF";
const root = mkdtempSync(join(tmpdir(), "signlayer-transcribe-test-"));
const clipsDir = join(root, "clips");
mkdirSync(clipsDir);
writeFileSync(join(clipsDir, "HELLO.mp4"), "synthetic fixture; not ASL");
writeFileSync(join(clipsDir, "manifest.json"), JSON.stringify({ HELLO: { gloss: "HELLO", file: "HELLO.mp4", seconds: 0.5 } }));
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const audio = (n = 4096) => Buffer.alloc(n, 7);

/** Fake client: reply(params, opts) -> {text} | throws. Records every call. */
function fakeClient(reply) {
  const calls = [];
  return { calls, audio: { transcriptions: { async create(params, opts) { calls.push({ params, opts }); return reply(params, opts); } } } };
}

let fake, app, base, appOff, baseOff, logs;
before(async () => {
  logs = [];
  fake = fakeClient(async (params) => {
    const bytes = Buffer.from(await params.file.arrayBuffer());
    if (bytes[0] === 1) throw Object.assign(new Error(`400 Invalid file format. key ${FAKE_KEY}`), { status: 400 });
    if (bytes[0] === 2) throw Object.assign(new Error(`429 rate limited, Bearer ${FAKE_KEY}`), { status: 429 });
    if (bytes[0] === 3) return { text: "  [Music]  " };
    if (bytes[0] === 4) return new Promise(() => {});          // never answers -> timeout
    return { text: " Hello,   thank you. " };
  });
  const transcriber = createTranscriber({ client: fake, model: "fake-transcribe", timeoutMs: 300, secrets: [FAKE_KEY] });
  app = createApp({ clipsDirs: [clipsDir], semantic: false, agent: null, transcriber, recognizerUrl: "http://127.0.0.1:1", log: (l) => logs.push(l) });
  base = await listen(app.server);
  appOff = createApp({ clipsDirs: [clipsDir], semantic: false, agent: null, transcriber: null, recognizerUrl: "http://127.0.0.1:1", log: () => {} });
  baseOff = await listen(appOff.server);
});
after(() => {
  app.server.close();
  appOff.server.close();
  rmSync(root, { recursive: true, force: true });
});

const post = (b, body, { type = "audio/webm;codecs=opus", query = "", headers = {} } = {}) =>
  fetch(`${b}/api/transcribe${query}`, { method: "POST", headers: { "content-type": type, ...headers }, body });

test("health reports transcribe ready / off", async () => {
  assert.equal((await (await fetch(`${base}/api/health`)).json()).transcribe, "ready");
  assert.equal((await (await fetch(`${baseOff}/api/health`)).json()).transcribe, "off");
});

test("transcribes a webm chunk: trimmed text, model, timings; sends file + language + prompt", async () => {
  const res = await post(base, audio(), { query: "?lang=en&prev=" + encodeURIComponent("so in college I was") });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.text, "Hello, thank you.");
  assert.equal(body.model, "fake-transcribe");
  assert.ok(body.timings.transcribe_ms >= 0 && body.timings.total_ms >= body.timings.transcribe_ms);
  const call = fake.calls.at(-1);
  assert.equal(call.params.model, "fake-transcribe");
  assert.equal(call.params.language, "en");
  assert.equal(call.params.prompt, "so in college I was");
  assert.equal(call.params.file.name, "chunk.webm");
  assert.equal(call.params.file.type, "audio/webm");
  assert.equal(call.params.file.size, 4096);
  assert.equal(call.opts.maxRetries, 0);
});

test("silence / music hallucinations come back as empty text", async () => {
  const res = await post(base, Buffer.concat([Buffer.from([3]), audio()]));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, "");
});

test("validation: type, size, duration header, lang, method, too short", async () => {
  let res = await post(base, audio(), { type: "application/json" });
  assert.equal(res.status, 415);
  assert.equal((await res.json()).error.code, "bad_audio_type");
  res = await post(base, Buffer.alloc(MAX_AUDIO_BYTES + 1, 7));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, "audio_too_large");
  res = await post(base, audio(), { headers: { "x-audio-ms": "45000" } });
  assert.equal(res.status, 413);
  res = await post(base, audio(), { query: "?lang=english" });
  assert.equal(res.status, 400);
  res = await post(base, audio(100));
  assert.equal((await res.json()).error.code, "audio_too_short");
  assert.equal((await fetch(`${base}/api/transcribe`)).status, 405);
});

test("upstream errors map to JSON errors and never leak the key", async () => {
  let res = await post(base, Buffer.concat([Buffer.from([1]), audio()]));
  assert.equal(res.status, 422);
  let text = await res.text();
  assert.match(text, /transcribe_bad_audio/);
  res = await post(base, Buffer.concat([Buffer.from([2]), audio()]));
  assert.equal(res.status, 429);
  res = await post(base, Buffer.concat([Buffer.from([4]), audio()]));
  assert.equal(res.status, 504);
  text += await res.text();
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(logs.some((l) => l.includes("transcribe failed")));
  assert.ok(logs.every((l) => !l.includes(FAKE_KEY) && !l.includes("FAKEfake")), "logs are redacted");
});

test("off without a key: 503 transcribe_off", async () => {
  const res = await post(baseOff, audio());
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "transcribe_off");
});

test("CORS preflight allows the extension's audio upload", async () => {
  const res = await fetch(`${base}/api/transcribe`, { method: "OPTIONS", headers: { origin: "chrome-extension://abc", "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-audio-ms" } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers"), /x-audio-ms/);
});
