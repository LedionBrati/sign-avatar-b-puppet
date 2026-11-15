// POST /api/compose with a FAKE OpenAI client (no network, no key).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../index.mjs";
import { createComposer, parseContext, parseSigns } from "../lib/compose.mjs";
import { SIGN_LABELS } from "../lib/sign-vocab.mjs";

const root = mkdtempSync(join(tmpdir(), "signlayer-compose-test-"));
const clipsDir = join(root, "clips");
mkdirSync(clipsDir);
writeFileSync(join(clipsDir, "HELLO.mp4"), "synthetic fixture; not ASL");
writeFileSync(join(clipsDir, "manifest.json"), JSON.stringify({ HELLO: { gloss: "HELLO", file: "HELLO.mp4", seconds: 0.5 } }));
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const post = (base, body) => fetch(`${base}/api/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const userMsg = (p) => p.input.at(-1).content;

let calls, app, base, appOff, baseOff;
before(async () => {
  calls = [];
  const client = { responses: { async create(p) {
    calls.push(p);
    const user = userMsg(p);
    if (user.includes("boom")) throw new Error("upstream down");
    if (user.includes("zebra")) return { output_text: JSON.stringify({ makes_sense: true, sentence: "Hello!", picked: [0, -1] }) };
    if (user.includes("wild")) return { output_text: JSON.stringify({ makes_sense: true, sentence: "Hi.", picked: [7, -3] }) };
    const sense = user.includes("hungry");
    return { output_text: JSON.stringify({ makes_sense: sense, sentence: sense ? "I'm hungry." : "I want something.", picked: sense ? [0, 1] : [0] }) };
  } } };
  app = createApp({ clipsDirs: [clipsDir], semantic: false, agent: null, transcriber: null, speaker: null, composer: createComposer({ client, model: "fake" }), recognizerUrl: "http://127.0.0.1:1", log: () => {} });
  base = await listen(app.server);
  appOff = createApp({ clipsDirs: [clipsDir], semantic: false, agent: null, transcriber: null, speaker: null, composer: null, recognizerUrl: "http://127.0.0.1:1", log: () => {} });
  baseOff = await listen(appOff.server);
});
after(() => { app.server.close(); appOff.server.close(); rmSync(root, { recursive: true, force: true }); });

test("compose: sensible signs -> sentence, guesses + vocabulary go to the model, picked is clamped", async () => {
  const r = await post(base, { signs: [{ text: "me", options: [{ text: "me", confidence: 0.9 }] }, { text: "hug", options: [{ text: "hug", confidence: 0.5 }, { text: "hungry", confidence: 0.4 }] }] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.makes_sense, true);
  assert.equal(j.sentence, "I'm hungry.");
  assert.deepEqual(j.picked, [0, 1]);
  const p = calls.at(-1);
  assert.match(userMsg(p), /\[1\] hungry 0\.4/);
  assert.equal(p.store, false);
  // Fixed, cacheable prefix: instructions, then the full recognizer vocabulary as a developer message.
  assert.equal(p.input[0].role, "developer");
  assert.ok(SIGN_LABELS.every((l) => p.input[0].content.includes(l)));
  assert.ok(p.prompt_cache_key);
});

test("compose: one sign is fine; same input is cached", async () => {
  const n = calls.length;
  const a = await (await post(base, { signs: [{ text: "want" }] })).json();
  const b = await (await post(base, { signs: [{ text: "want" }] })).json();
  assert.equal(a.sentence, "I want something.");
  assert.equal(b.cached, true);
  assert.equal(calls.length, n + 1);
});

test("compose: a dropped sign comes back as -1; out-of-range picks fall back to 0", async () => {
  const a = await (await post(base, { signs: [{ text: "hello", options: [{ text: "hello", confidence: 0.9 }] }, { text: "zebra", options: [{ text: "zebra", confidence: 0.07 }, { text: "owl", confidence: 0.06 }] }] })).json();
  assert.equal(a.sentence, "Hello!");
  assert.deepEqual(a.picked, [0, -1]);
  const b = await (await post(base, { signs: [{ text: "wild" }, { text: "two" }] })).json();
  assert.deepEqual(b.picked, [0, 0]);
});

test("compose: context (said, heard) reaches the model and is part of the cache key", async () => {
  const n = calls.length;
  const body = { signs: [{ text: "hungry" }, { text: "pizza" }], context: { said: ["one", "Hello!", "Thank you!"], heard: "What do you want to eat?" } };
  assert.equal((await post(base, body)).status, 200);
  const user = userMsg(calls.at(-1));
  assert.match(user, /Hearing person just said: "What do you want to eat\?"/);
  assert.match(user, /Signer said earlier: "Thank you!"/);
  assert.doesNotMatch(user, /"one"/); // only the last 2 sentences
  await post(base, { signs: body.signs }); // same signs, no context: a different request
  assert.equal(calls.length, n + 2);
  assert.equal((await post(base, { signs: body.signs, context: "nope" })).status, 400);
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

test("parseSigns: caps options at 5, clamps confidence, trims text; parseContext tolerates missing context", () => {
  const s = parseSigns({ signs: [{ text: "  hi ", options: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ text: `o${i}`, confidence: i === 1 ? 1.7 : 0.1 })) }] });
  assert.equal(s[0].text, "hi");
  assert.equal(s[0].options.length, 5);
  assert.equal(s[0].options[0].confidence, 1);
  assert.deepEqual(parseContext({}), {});
  assert.deepEqual(parseContext({ context: { heard: "  hi  there " } }), { heard: "hi there" });
  assert.equal(parseSigns({ signs: Array(8).fill({ text: "a" }) }).length, 8);
  assert.throws(() => parseSigns({ signs: Array(9).fill({ text: "a" }) }));
});

test("sign-vocab.mjs matches the web app's SIGN_VOCAB (250 recognizer labels)", () => {
  const src = readFileSync(new URL("../../web/src/lib/vocab.ts", import.meta.url), "utf8");
  const web = JSON.parse(src.slice(src.indexOf("= [") + 2, src.indexOf("];") + 1).replace(/,\s*\]$/, "]"));
  assert.equal(SIGN_LABELS.length, 250);
  assert.deepEqual([...SIGN_LABELS], web);
});

test("compose-cases fixture (scripts/compose-check.mjs): realistic top-5 cases all parse", () => {
  const { cases } = JSON.parse(readFileSync(new URL("./fixtures/compose-cases.json", import.meta.url), "utf8"));
  const display = new Set(["thank you", "hurt", "you", "ice cream", "have to"]); // labelText() of thankyou, owie, ...
  assert.ok(cases.length >= 15);
  for (const c of cases) {
    const signs = parseSigns({ signs: c.signs.map((o) => ({ text: o[0][0], options: o.map(([text, confidence]) => ({ text, confidence })) })) });
    assert.ok(signs.every((x) => x.options.length === 5));
    assert.ok(c.signs.flat().every(([t]) => SIGN_LABELS.includes(t) || display.has(t)), JSON.stringify(c.signs));
  }
});

test("compose: history becomes a transcript in the input, is validated, and is part of the cache key", async () => {
  const n = calls.length;
  const history = [{ who: "them", text: "Hi there!" }, { who: "me", text: "Hello!" }, { who: "them", text: "How are you?" }];
  const body = { signs: [{ text: "good", options: [{ text: "good", confidence: 0.5 }, { text: "fine", confidence: 0.4 }] }], context: { history, heard: "How are you?" } };
  assert.equal((await post(base, body)).status, 200);
  const user = userMsg(calls.at(-1));
  assert.match(user, /Them: "Hi there!"\nMe \(signing\): "Hello!"\nThem: "How are you\?"/);
  assert.match(user, /last thing they heard: "How are you\?"/);
  assert.doesNotMatch(user, /Hearing person just said/); // heard repeats the last turn: shown once
  // A different history is a different request (no stale cache hit).
  await post(base, { ...body, context: { history: [{ who: "them", text: "What do you want to drink?" }] } });
  assert.equal(calls.length, n + 2);
  for (const bad of ["nope", [{ who: "them" }], [{ who: "you", text: "hi" }], [null], [{ who: "me", text: 3 }]]) {
    assert.equal((await post(base, { signs: [{ text: "good" }], context: { history: bad } })).status, 400, JSON.stringify(bad));
  }
  assert.equal(calls.length, n + 2);
});

test("parseContext: history keeps the last 12 non-empty turns, each cut to 300 chars; said/heard still work", () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ who: i % 2 ? "me" : "them", text: i === 19 ? "x".repeat(500) : `turn ${i}` }));
  history.splice(10, 0, { who: "me", text: "   " });
  const c = parseContext({ context: { history, said: ["Hello!"], heard: "Bye" } });
  assert.equal(c.history.length, 12);
  assert.deepEqual(c.history[0], { who: "them", text: "turn 8" });
  assert.equal(c.history.at(-1).text.length, 300);
  assert.deepEqual(c.said, ["Hello!"]);
  assert.equal(c.heard, "Bye");
  assert.deepEqual(parseContext({ context: { history: [] } }), {});
  // A sign the recognizer flagged as junk is marked for the model.
  const signs = parseSigns({ signs: [{ text: "hello" }, { text: "zebra", reject: true }] });
  assert.equal(signs[1].reject, true);
  assert.equal(signs[0].reject, undefined);
});
