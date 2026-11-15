// Agent layer with a FAKE OpenAI client (no network, no key). Synthetic clip bytes; not ASL.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, better } from "../index.mjs";
import { buildPlan, createAgent, describeVocab, PLAN_SCHEMA } from "../lib/agent.mjs";
import { loadApiKey, redactor } from "../lib/secrets.mjs";
import { loadVocab } from "../../../translate/node.mjs";

const IDS = ["HELLO", "MY", "NAME", "THANK_YOU", "SEE", "YOU", "LATER", "WHERE", "HURT"];
const root = mkdtempSync(join(tmpdir(), "signlayer-agent-test-"));
const dir = join(root, "clips");
mkdirSync(dir);
writeFileSync(join(dir, "manifest.json"), JSON.stringify(Object.fromEntries(IDS.map((id) => {
  writeFileSync(join(dir, `${id}.mp4`), "synthetic fixture; not ASL");
  return [id, { gloss: id.replaceAll("_", " "), file: `${id}.mp4`, seconds: 0.5 }];
}))));
const FAKE_KEY = "sk-proj-FAKEfakeFAKEfake0123456789abcdefABCDEF";

const sign = (id, source, covers = [source], confidence = 0.9) => ({ type: "sign", id, letters: null, source, covers, confidence });
const proposal = (items, extra = {}) => ({ items, markers: [], unsupported: [], paraphrase: "", notes: "", ...extra });
const reply = (obj) => ({ status: "completed", output_text: JSON.stringify(obj),
  usage: { input_tokens: 700, output_tokens: 150, input_tokens_details: { cached_tokens: 512 } } });
/** Text back from the numbered user message "0:Thanks 1:a ...". */
const textOf = (params) => params.input.at(-1).content.split(" ").map((s) => s.slice(s.indexOf(":") + 1)).join(" ");

/** Fake OpenAI client: script[text] is a proposal object, or (params, opts, n) => response | Promise | throws. */
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    responses: {
      async create(params, opts) {
        calls.push({ params, opts, text: textOf(params) });
        const s = script[textOf(params)];
        if (typeof s === "function") return s(params, opts, calls.filter((c) => c.text === textOf(params)).length);
        if (!s) throw Object.assign(new Error("no script"), { status: 500 });
        return reply(s);
      },
    },
  };
}

const SCRIPT = {
  "Thanks a lot, catch you later": proposal([sign("THANK_YOU", 0, [0, 1, 2]), sign("SEE", 3, [3], 0.8), sign("YOU", 4), sign("LATER", 5)],
    { paraphrase: "Thank you very much, see you later.", notes: "catch -> SEE" }),
  // Invented sign: DOCTOR is not in the vocab.
  "Hello doctor": proposal([sign("HELLO", 0), sign("DOCTOR", 1)], { paraphrase: "Hello, doctor." }),
  // Silently leaves out a content word ("tomorrow").
  "See you tomorrow": proposal([sign("SEE", 0), sign("YOU", 1)], { paraphrase: "See you." }),
  // Drops the negation.
  "I don't see you": proposal([sign("SEE", 2), sign("YOU", 3)], { unsupported: [0], paraphrase: "See you." }),
  // Hides the risky dropped "it" inside covers of a literal sign.
  "Does it hurt?": proposal([sign("HURT", 2, [0, 1, 2])], { markers: [{ type: "question_yn", from: 0, to: 0 }], paraphrase: "Hurt?" }),
  // Literal plan for a sentence the local translator already handles (used with agent: "always").
  "Hello, thank you.": proposal([sign("HELLO", 0), sign("THANK_YOU", 1, [1, 2])], { paraphrase: "Hello, thank you." }),
  "Hey there!": proposal([sign("HELLO", 0, [0, 1], 0.85)], { paraphrase: "Hello!" }),
  "Bye Zoe": proposal([sign("HELLO", 0, [0], 0.3), { type: "fingerspell", id: null, letters: "ZOEY", source: 1, covers: [1], confidence: 1 }]),
  "Where is the pain": proposal([sign("HURT", 3, [3], 0.8), sign("GHOST", 0), sign("WHERE", 0)],
    { markers: [{ type: "question_wh", from: 0, to: 2 }], paraphrase: "Where does it hurt?" }),
  "Slow sentence": () => new Promise(() => {}),                                     // never answers
  "Flaky once": (_p, _o, n) => { if (n === 1) throw Object.assign(new Error("upstream 503"), { status: 503 }); return reply(proposal([sign("HELLO", 0, [0, 1])], { paraphrase: "Hello." })); },
  "Not json": () => ({ status: "completed", output_text: "{oops" }),
  "Leaky error": () => { throw Object.assign(new Error(`401 Incorrect API key provided: ${FAKE_KEY}. Authorization: Bearer ${FAKE_KEY}`), { status: 401 }); },
};

const client = fakeClient(SCRIPT);
const logs = [];
const agent = createAgent({ client, model: "fake-model", timeoutMs: 400, retries: 1, secrets: [FAKE_KEY] });
const app = createApp({ clipsDirs: [dir], semantic: false, agent, log: (l) => logs.push(l) });
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
after(() => { app.server.close(); rmSync(root, { recursive: true, force: true }); });

async function post(body) {
  const res = await fetch(`${base}/api/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const callsFor = (text) => client.calls.filter((c) => c.text === text).length;

test("health reports the agent; request uses structured outputs with a strict schema, store: false", async () => {
  assert.equal((await (await fetch(`${base}/api/health`)).json()).agent, "ready");
  await post({ text: "Thanks a lot, catch you later" });
  const p = client.calls.find((c) => c.text === "Thanks a lot, catch you later").params;
  assert.equal(p.text.format.type, "json_schema");
  assert.equal(p.text.format.strict, true);
  assert.deepEqual(p.text.format.schema, PLAN_SCHEMA);
  assert.equal(p.store, false);
  assert.match(p.input[0].content, /^VOCAB \(9 signs\):\nHELLO, MY, NAME, THANK_YOU/);
});

test("local fully supported -> agent not called (auto); agent: off never calls", async () => {
  const before = client.calls.length;
  const { body } = await post({ text: "Where does it hurt?" });
  assert.equal(body.translator, "local");
  assert.equal(body.safety.status, "fully_supported");
  assert.equal(body.agent, undefined);
  const off = await post({ text: "Thanks a lot, catch you later", agent: "off" });
  assert.equal(off.body.translator, "local");
  assert.equal(off.body.safety.status, "caption_only");
  assert.equal(client.calls.length, before);
  assert.equal((await post({ text: "hi", agent: "maybe" })).body.error.code, "bad_agent");
});

test("agent paraphrase beats a caption-only local plan, but still needs confirmation (no playback)", async () => {
  const { body } = await post({ text: "Thanks a lot, catch you later" });
  assert.equal(body.translator, "agent");
  assert.equal(body.paraphrase, "Thank you very much, see you later.");
  assert.equal(body.safety.status, "needs_confirmation");
  assert.deepEqual(body.playlist, []);
  assert.equal(body.agent.local_status, "caption_only");
  const items = body.plan.items.map((i) => `${i.motion_id}:${i.match.method}`);
  assert.deepEqual(items, ["THANK_YOU:semantic", "SEE:semantic", "YOU:exact", "LATER:exact"]);
  assert.ok(body.safety.reasons.every((r) => r.code === "semantic_uncertainty"));
  assert.deepEqual(body.plan.dropped_tokens, ["a"]);
});

test("invented motion_id is rejected, never played; its word becomes unsupported", async () => {
  const { body } = await post({ text: "Hello doctor" });
  assert.equal(body.translator, "local");                       // agent plan is not better: both caption-only
  assert.deepEqual(body.agent.rejected, [{ reason: "not_in_vocab", id: "DOCTOR", source: "doctor" }]);
  assert.equal(body.agent.status, "caption_only");
  assert.ok(!JSON.stringify(body.plan).includes("DOCTOR"));
  assert.ok(logs.some((l) => l.includes("not_in_vocab:DOCTOR")));
  const r = await post({ text: "Hello doctor", agent: "always" });
  assert.equal(r.body.translator, "agent");
  assert.ok(!r.body.plan.items.some((i) => i.motion_id === "DOCTOR"));
  assert.deepEqual(r.body.plan.unsupported_tokens, ["doctor"]);
  assert.deepEqual(r.body.playlist, []);
});

test("safety gate still blocks partial agent plans", async () => {
  for (const [text, code] of [["See you tomorrow", "unsupported_token"], ["I don't see you", "unrepresented_negation"], ["Does it hurt?", "dropped_meaning"]]) {
    const { body } = await post({ text, agent: "always" });
    assert.equal(body.translator, "agent", text);
    assert.equal(body.safety.status, "caption_only", text);
    assert.ok(body.safety.reasons.some((r) => r.code === code), `${text}: ${JSON.stringify(body.safety.reasons)}`);
    assert.deepEqual(body.playlist, [], text);
    assert.deepEqual(body.markers, [], text);
  }
});

test("a literal agent plan is verified against the local rules and can play (agent: always)", async () => {
  const { body } = await post({ text: "Hello, thank you.", agent: "always" });
  assert.equal(body.translator, "agent");
  assert.equal(body.safety.status, "fully_supported");
  assert.deepEqual(body.playlist.map((p) => p.motion_id), ["HELLO", "THANK_YOU"]);
  assert.deepEqual(body.plan.items.map((i) => i.match.method), ["exact", "phrase"]);
  assert.deepEqual(body.playlist.map((p) => p.word_index), [0, 1]);
});

test("fingerspelling must spell the source word; markers are remapped after rejected items", async () => {
  let { body } = await post({ text: "Bye Zoe", agent: "always" });
  assert.deepEqual(body.agent.rejected, [{ reason: "fingerspell_mismatch", letters: "ZOEY", source: "Zoe" }]);
  assert.ok(body.plan.unsupported_tokens.includes("Zoe"));
  ({ body } = await post({ text: "Where is the pain", agent: "always" }));
  assert.deepEqual(body.plan.items.map((i) => i.motion_id), ["HURT", "WHERE"]);
  assert.deepEqual(body.plan.nonmanual_markers, [{ type: "question_wh", from: 0, to: 1 }]);
});

test("cache: the same text + vocab is planned once", async () => {
  const n = callsFor("Hey there!");
  const a = await post({ text: "Hey there!" });
  const b = await post({ text: "Hey there!" });
  assert.equal(callsFor("Hey there!"), n + 1);
  assert.equal(a.body.agent.cached, false);
  assert.equal(b.body.agent.cached, true);
  assert.deepEqual(b.body.plan, a.body.plan);
  assert.equal(agent.stats.cache_hits >= 1, true);
});

test("timeout falls back to the local result quickly, with a warning", async () => {
  const t0 = performance.now();
  const { status, body } = await post({ text: "Slow sentence" });
  assert.equal(status, 200);
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(body.translator, "local");
  assert.equal(body.agent.code, "timeout");
  assert.match(body.warnings[0], /agent unavailable \(timeout\); local translation used/);
  assert.equal(callsFor("Slow sentence"), 1);                   // no budget left for a retry
  assert.ok(client.calls.find((c) => c.text === "Slow sentence").opts.signal.aborted);
});

test("one retry on a transient error; bad JSON falls back", async () => {
  const { body } = await post({ text: "Flaky once" });
  assert.equal(callsFor("Flaky once"), 2);
  assert.equal(body.agent.status, "needs_confirmation");
  const bad = await post({ text: "Not json" });
  assert.equal(bad.body.translator, "local");
  assert.equal(bad.body.agent.code, "bad_json");
});

test("the API key never appears in errors, warnings or logs", async () => {
  const { body } = await post({ text: "Leaky error" });
  const all = JSON.stringify(body) + logs.join("\n");
  assert.ok(!all.includes(FAKE_KEY));
  assert.ok(!all.includes("FAKEfakeFAKE"));
  assert.match(body.agent.error, /\[redacted\]/);
  assert.equal(callsFor("Leaky error"), 1);                     // 401 is not retried
  assert.equal(redactor()(`key sk-abc123def456ghi and Bearer abcdefghijkl`), "key [redacted] and Bearer [redacted]");
});

test("loadApiKey: env wins, file is trimmed, errors never contain the file content", () => {
  const f = join(root, "key.txt");
  writeFileSync(f, `﻿  ${FAKE_KEY}  \r\n\r\n`);
  assert.deepEqual(loadApiKey({ OPENAI_API_KEY_FILE: f }), { key: FAKE_KEY, source: "file" });
  assert.deepEqual(loadApiKey({ OPENAI_API_KEY: " sk-env-1234567890 ", OPENAI_API_KEY_FILE: f }), { key: "sk-env-1234567890", source: "env" });
  assert.equal(loadApiKey({}).key, null);
  const missing = loadApiKey({ OPENAI_API_KEY_FILE: join(root, "nope.txt") });
  assert.equal(missing.key, null);
  assert.match(missing.error, /cannot read OPENAI_API_KEY_FILE/);
  writeFileSync(f, "\n  \n");
  assert.match(loadApiKey({ OPENAI_API_KEY_FILE: f }).error, /is empty/);
});

test("no env agent under node --test, even with a key in the environment", () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = FAKE_KEY;
  try {
    const a = createApp({ clipsDirs: [dir], semantic: false, log: () => {} });
    assert.equal(a.state.agent, "off");
    assert.equal(a.agent, null);
  } finally { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }
});

test("better(): only a strictly better gate decision wins", () => {
  const r = (status, n = 1) => ({ safety: { status, reasons: Array(n).fill({}) } });
  assert.equal(better(r("needs_confirmation"), r("caption_only")), true);
  assert.equal(better(r("caption_only"), r("caption_only", 5)), false);
  assert.equal(better(r("fully_supported", 0), r("needs_confirmation")), true);
  assert.equal(better(r("needs_confirmation", 1), r("needs_confirmation", 2)), true);
  assert.equal(better(r("needs_confirmation", 2), r("needs_confirmation", 2)), false);
});

test("buildPlan accepts a spelling slip of a real ID, never an unknown one", () => {
  const vocab = IDS.map((id) => ({ motion_id: id, gloss: id.replaceAll("_", " ") }));
  const v = describeVocab(vocab);
  const words = ["Thank", "you"];
  const { plan, rejected } = buildPlan("Thank you", words, proposal([sign("THANK YOU", 0, [0, 1]), sign("THANKS_YOU", 1)]), v.byId, vocab);
  assert.deepEqual(plan.items.map((i) => [i.motion_id, i.gloss, i.match.method]), [["THANK_YOU", "THANK YOU", "phrase"]]);
  assert.deepEqual(rejected.map((r) => r.id), ["THANKS_YOU"]);
});

let dictionary = null;
try { dictionary = loadVocab("dictionary"); } catch { /* optional */ }
test("dictionary vocab (1,945 signs) is described compactly as IDs", { skip: !dictionary && "dictionary not found" }, () => {
  const v = describeVocab(dictionary);
  assert.ok(v.count > 1900);
  assert.ok(v.text.length < v.count * 14, `${v.text.length} chars`);     // ~IDs only
  assert.equal(describeVocab(dictionary), v);                              // cached per vocab array
});
