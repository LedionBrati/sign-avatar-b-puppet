// app/core/src/context.ts picks exactly like app/recognizer/context.py on the shared fixture
// (written by: app/recognizer/.venv/Scripts/python app/recognizer/tests/test_context.py --write).
//   node --experimental-strip-types --test app/core/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEMO_SENTENCES, bigram, contextLabels, contextPick } from "../src/context.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/context-fixture.json", import.meta.url), "utf8"));
const lm = bigram(DEMO_SENTENCES);   // the prior context.py uses by default

test("same picks as context.py on the fixture", () => {
  for (const c of fx) assert.deepEqual(contextPick(c.signs, { lm }), c.picked);
});

test("a sentence prior settles a close call, a sure guess stands; no prior keeps the top guess", () => {
  const signs = [{ options: [{ label: "ME", confidence: 0.9 }] },
    { options: [{ label: "BYE", confidence: 0.4 }, { label: "HUNGRY", confidence: 0.38 }, { label: "WATER", confidence: 0.1 }] }];
  assert.deepEqual(contextLabels(signs, { lm }), ["ME", "HUNGRY"]);
  assert.deepEqual(contextLabels(signs), ["ME", "BYE"]);
  signs[1].options[0].confidence = 0.97; signs[1].options[1].confidence = 0.02;
  assert.deepEqual(contextLabels(signs, { lm }), ["ME", "BYE"]);
});

test("a guess picked from the chips is kept; a sign without guesses is skipped", () => {
  const signs = [{ options: [{ label: "BYE", confidence: 0.95 }, { label: "HELLO", confidence: 0.03 }], fixed: true, sel: 1 },
    { options: [] }, { options: [{ label: "NICE", confidence: 0.9 }] }];
  assert.deepEqual(contextPick(signs), [1, -1, 0]);
  assert.deepEqual(contextLabels(signs), ["HELLO", "NICE"]);
});
