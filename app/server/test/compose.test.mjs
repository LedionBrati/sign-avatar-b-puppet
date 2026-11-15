// POST /api/compose with a FAKE OpenAI client (no network, no key).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../index.mjs";
import { createComposer, parseSigns } from "../lib/compose.mjs";

const root = mkdtempSync(join(tmpdir(), "signlayer-compose-test-"));
const clipsDir = join(root, "clips");
mkdirSync(clipsDir);
writeFileSync(join(clipsDir, "HELLO.mp4"), "synthetic fixture; not ASL");
writeFileSync(join(clipsDir, "manifest.json"), JSON.stringify({ HELLO: { gloss: "HELLO", file: "HELLO.mp4", seconds: 0.5 } }));
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const post = (base, body) => fetch(`${base}/api/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let calls, app, base, appOff, baseOff;
before(async () => {
  calls = [];
  const client = { responses: { async create(p) {
    calls.push(p);
    if (p.input.includes("boom")) throw new Error("upstream down");
    const sense = p.input.includes("hungry");
    return { output_text: JSON.stringify({ makes_sense: sense, sentence: sense ? "I'm hungry." : "I want...", picked: sense ? [0, 1] : [0] }) };
  } } };
  app = createApp({ clipsDirs: [clipsDir], semantic: false, agent: null, transcriber: null, composer: createComposer({ client, model: "fake" }), recognizerUrl: "http://127.0.0.1:1", log: () => {} });
  base = await listen(app.server);
  appOff = createApp({ clipsDirs: [clipsDir], semantic: false, agent: null, transcriber: null, composer: null, recognizerUrl: "http://127.0.0.1:1", log: () => {} });
  baseOff = await listen(appOff.server);
});
after(() => { app.server.close(); appOff.server.close(); rmSync(root, { recursive: true, force: true }); });

test("compose: sensible signs -> sentence, guesses go to the model, picked is clamped", async () => {
  const r = await post(base, { signs: [{ text: "me", options: [{ text: "me", confidence: 0.9 }] }, { text: "hug", options: [{ text: "hug", confidence: 0.5 }, { text: "hungry", confidence: 0.4 }] }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.makes_sense, true);
  assert.equal(j.sentence, "I'm hungry.");
  assert.deepEqual(j.picked, [0, 1]);
  assert.match(calls.at(-1).input, /\[1\] hungry 0\.4/);
  assert.equal(calls.at(-1).store, false);
});

test("compose: fragment -> makes_sense false; same input is cached", async () => {
  const n = calls.length;
  const a = await (await post(base, { signs: [{ text: "want" }] })).json();
  const b = await (await post(base, { signs: [{ text: "want" }] })).json();
  assert.equal(a.makes_sense, false);
  assert.equal(b.cached, true);
  assert.equal(calls.length, n + 1);
});

test("compose: bad bodies are 400, model failure is 502, no key is 503", async () => {
  assert.equal((await post(base, { signs: [] })).status, 400);
  assert.equal((await post(base, { signs: [{ text: "" }] })).status, 400);
  assert.equal((await post(base, { nope: 1 })).status, 400);
  assert.equal((await post(base, { signs: [{ text: "boom" }] })).status, 502);
  const off = await post(baseOff, { signs: [{ text: "me" }] });
  assert.equal(off.status, 503);
  assert.equal((await off.json()).error.code, "compose_off");
  assert.equal((await (await fetch(`${baseOff}/api/health`)).json()).compose, "off");
});

test("parseSigns: caps options at 3 and trims text", () => {
  const s = parseSigns({ signs: [{ text: "  hi ", options: [1, 2, 3, 4].map((i) => ({ text: `o${i}`, confidence: 0.1 })) }] });
  assert.equal(s[0].text, "hi");
  assert.equal(s[0].options.length, 3);
});
