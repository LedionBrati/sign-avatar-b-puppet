// Synthetic clip manifests only. These bytes and glosses are not ASL recordings or QA.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../index.mjs";
import { assessSigning } from "../lib/semantic-safety.mjs";
import { translateRules } from "../../../translate/index.mjs";

const root = mkdtempSync(join(tmpdir(), "flux-safety-test-"));
const dir = join(root, "clips");
mkdirSync(dir);
const ids = ["HELLO", "THANK_YOU", "YES", "NO", "I", "WANT", "THAT", "TURN", "RIGHT", "BANK", "YOU", "PAY", "FINE", "MY", "HUSBAND", "NEED", "HELP", "NAME"];
const manifest = Object.fromEntries(ids.map((id) => {
  writeFileSync(join(dir, `${id}.mp4`), "synthetic fixture; not ASL");
  return [id, { gloss: id.replaceAll("_", " "), file: `${id}.mp4`, seconds: 0.5 }];
}));
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
const app = createApp({ clipsDirs: [dir], semantic: false, log: () => {} });
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
after(() => { app.server.close(); rmSync(root, { recursive: true, force: true }); });

async function sign(text) {
  const res = await fetch(`${base}/api/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, semantic: false }) });
  assert.equal(res.status, 200);
  return res.json();
}

test("complete deterministic phrases play; original caption is exact", async () => {
  for (const [text, expected] of [
    ["  Hello, thank you.  ", ["HELLO", "THANK_YOU"]],
    ["Yes, thank you.", ["YES", "THANK_YOU"]],
    ["No, thank you.", ["NO", "THANK_YOU"]],
    ["I want that.", ["I", "WANT", "THAT"]],
  ]) {
    const out = await sign(text);
    assert.equal(out.text, text);
    assert.equal(out.safety.caption, text);
    assert.equal(out.safety.status, "fully_supported", text);
    assert.deepEqual(out.playlist.map((p) => p.motion_id), expected);
  }
});

test("meaning-changing and incomplete cases return no playable prefix", async () => {
  const cases = [
    ["I don't want that.", "caption_only", "unrepresented_negation"],
    ["Turn right at the bank.", "needs_confirmation", "ambiguous_sense"],
    ["You have to pay a fine.", "needs_confirmation", "ambiguous_sense"],
    ["My spouse needs help.", "caption_only", "unsupported_token"],
    ["My appointment is at 3:30.", "caption_only", "numerical_meaning"],
    ["Hello, my name is Maria.", "caption_only", "missing_fingerspelling"],
    ["Xylophone banana.", "caption_only", "unsupported_token"],
  ];
  for (const [text, status, code] of cases) {
    const out = await sign(text);
    assert.equal(out.safety.status, status, text);
    assert.ok(out.safety.reasons.some((r) => r.code === code), text);
    assert.deepEqual(out.playlist, [], text);
    assert.deepEqual(out.markers, [], text);
    assert.equal(out.safety.caption, text);
    const mp4 = await fetch(`${base}/api/sign.mp4?text=${encodeURIComponent(text)}&semantic=false`);
    assert.equal(mp4.status, 422, text);
    const blocked = await mp4.json();
    assert.equal(blocked.safety.status, status, text);
    assert.deepEqual(blocked.playlist, [], text);
  }
});

test("missing one letter keeps the entire name and sentence caption-only", () => {
  const text = "Hello, my name is Maria.";
  const plan = translateRules(text, app.vocab);
  const letters = new Map([..."MAR"].map((letter) => [letter, { motion_id: letter, gloss: letter }]));
  const safety = assessSigning(text, plan, { signs: app.clips.signs, letters });
  assert.equal(safety.status, "caption_only");
  assert.deepEqual(safety.reasons.find((r) => r.code === "missing_fingerspelling").missing_letters, ["I"]);
});

test("a valid plan with an unavailable clip is caption-only", () => {
  const text = "Hello, thank you.";
  const plan = translateRules(text, app.vocab);
  const signs = new Map(app.clips.signs);
  signs.delete("THANK_YOU");
  const safety = assessSigning(text, plan, { signs, letters: new Map() });
  assert.equal(safety.status, "caption_only");
  assert.equal(safety.reasons.find((r) => r.code === "missing_clip").motion_id, "THANK_YOU");
});

test("semantic score does not prove meaning; spouse to husband is blocked", () => {
  const text = "My spouse needs help.";
  const plan = translateRules(text, app.vocab);
  const idx = plan.items.findIndex((i) => i.source?.toLowerCase() === "needs");
  plan.unsupported_tokens = [];
  plan.items.splice(idx, 0, { type: "sign", motion_id: "HUSBAND", gloss: "HUSBAND", source: "spouse", source_index: 1,
    match: { method: "semantic", score: 0.86 } });
  let safety = assessSigning(text, plan, app.clips);
  assert.equal(safety.status, "caption_only");
  assert.ok(safety.reasons.some((r) => r.code === "semantic_substitution"));
  plan.items[idx].match.score = NaN;
  safety = assessSigning(text, plan, app.clips);
  assert.ok(safety.reasons.some((r) => r.code === "invalid_plan"));
});

test("an uncertain semantic match needs confirmation and malformed provenance is blocked", () => {
  const text = "Hello.";
  const plan = translateRules(text, app.vocab);
  plan.items[0].match = { method: "semantic", score: 0.98 };
  let safety = assessSigning(text, plan, app.clips);
  assert.equal(safety.status, "needs_confirmation");
  assert.deepEqual(safety.reasons.map((r) => r.code), ["semantic_uncertainty"]);
  plan.items[0].source = "goodbye";
  safety = assessSigning(text, plan, app.clips);
  assert.equal(safety.status, "caption_only");
  assert.ok(safety.reasons.some((r) => r.code === "invalid_plan"));
});
