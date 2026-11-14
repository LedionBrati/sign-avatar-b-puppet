import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertPlan, assertCatalog, resolvePlan, preparePlayback, loadPlayback, lookupRecognizerLabel } from "./contracts.mjs";

const validPlan = () => ({
  input_text: "Hello",
  items: [{ type: "sign", gloss: "HELLO", motion_id: "HELLO" }],
  nonmanual_markers: [],
  unsupported_tokens: [],
  caption: "Hello",
});
const sign = (id, overrides = {}) => ({
  id, gloss: id, status: "verified", motion_path: "motion/" + id + ".json",
  source: "synthetic test fixture", license: "test-only", ...overrides,
});
const catalog = (...signs) => ({
  schema_version: 1, signs, fingerspelling: {},
});

test("accepts a fully ordered fingerspelling-first plan and inclusive nonmanual span", () => {
  const plan = {
    ...validPlan(),
    items: [
      { type: "fingerspell", word: "A" },
      { type: "sign", gloss: "HELLO", motion_id: "HELLO", hold_ms: 100 },
    ],
    nonmanual_markers: [{ type: "question_yn", from: 0, to: 1 }],
  };
  assert.equal(assertPlan(plan), plan);
});

test("rejects invalid marker ranges and malformed items", () => {
  const plan = validPlan();
  plan.nonmanual_markers = [{ type: "question_yn", from: 0, to: 1 }];
  assert.throws(() => assertPlan(plan), /inclusive span/);
  plan.nonmanual_markers = [];
  plan.items = [{ type: "fingerspell", word: "Hi" }];
  assert.throws(() => assertPlan(plan), /A-Z uppercase/);
});

test("catalog rejects duplicate IDs and incomplete verified assets", () => {
  assert.throws(() => assertCatalog(catalog(sign("HELLO"), sign("HELLO"))), /duplicate sign ID/);
  assert.throws(() => assertCatalog(catalog(sign("HELLO", { motion_path: undefined }))), /missing motion_path/);
});

test("unknown sign never becomes an invented motion", () => {
  const resolved = resolvePlan(validPlan(), catalog());
  assert.equal(resolved.resolvable, false);
  assert.equal(resolved.sequence.length, 0);
  assert.equal(resolved.blocked[0].motion_id, "HELLO");
});

test("verified registered sign resolves deterministically", () => {
  const resolved = resolvePlan(validPlan(), catalog(sign("HELLO")));
  assert.equal(resolved.resolvable, true);
  assert.equal(resolved.sequence[0].motion_path, "motion/HELLO.json");
});

test("fingerspelling never silently emits a partial word", () => {
  const plan = { ...validPlan(), items: [{ type: "fingerspell", word: "AB" }] };
  const list = catalog(sign("FS_A", { letter: "A" }));
  list.fingerspelling = { A: "FS_A" };
  const resolved = resolvePlan(plan, list);
  assert.equal(resolved.resolvable, false);
  assert.deepEqual(resolved.sequence, []);
  assert.match(resolved.blocked[0].reason, /B/);
});

test("complete fingerspelling uses catalog map in the same item slot", () => {
  const plan = {
    ...validPlan(),
    items: [{ type: "fingerspell", word: "BA" }, { type: "sign", gloss: "HELLO", motion_id: "HELLO" }],
  };
  const list = catalog(sign("FS_A", { letter: "A" }), sign("FS_B", { letter: "B" }), sign("HELLO"));
  list.fingerspelling = { A: "FS_A", B: "FS_B" };
  const resolved = resolvePlan(plan, list);
  assert.equal(resolved.resolvable, true);
  assert.deepEqual(resolved.sequence.map((x) => x.motion_id), ["FS_B", "FS_A", "HELLO"]);
});

test("unsupported tokens explicitly block a purported complete rendering", () => {
  const plan = { ...validPlan(), unsupported_tokens: ["unknown"] };
  const resolved = resolvePlan(plan, catalog(sign("HELLO")));
  assert.equal(resolved.resolvable, false);
  assert.match(resolved.blocked[0].reason, /do not invent/);
});

test("canonical IDs and local motion references are required", () => {
  assert.throws(() => assertPlan({ ...validPlan(), items: [{ type: "sign", gloss: "HELLO", motion_id: "hello" }] }), /canonical ID/);
  assert.throws(() => assertCatalog(catalog(sign("HELLO", { motion_path: "../secret.json" }))), /project-relative/);
  assert.throws(() => assertCatalog(catalog(sign("HELLO", { motion_path: "https://example.com/clip.json" }))), /project-relative/);
});

test("a plan gloss cannot silently select a different catalog sign", () => {
  const plan = { ...validPlan(), items: [{ type: "sign", gloss: "GOODBYE", motion_id: "HELLO" }] };
  const result = preparePlayback(plan, catalog(sign("HELLO")));
  assert.equal(result.status, "unsupported");
  assert.equal(result.blocked[0].code, "gloss_mismatch");
});

test("one missing item blocks the whole sequence instead of a playable prefix", () => {
  const plan = { ...validPlan(), items: [...validPlan().items, { type: "sign", gloss: "MISSING", motion_id: "MISSING" }] };
  const result = resolvePlan(plan, catalog(sign("HELLO")));
  assert.equal(result.resolvable, false);
  assert.deepEqual(result.sequence, []);
  assert.equal(preparePlayback(plan, catalog(sign("HELLO"))).status, "unsupported");
});

test("facial spans expand across an atomic fingerspelled word", () => {
  const plan = { ...validPlan(), items: [{ type: "fingerspell", word: "AB" }, ...validPlan().items],
    nonmanual_markers: [{ type: "question_yn", from: 0, to: 1 }] };
  const list = catalog(sign("FS_A", { letter: "A" }), sign("FS_B", { letter: "B" }), sign("HELLO"));
  list.fingerspelling = { A: "FS_A", B: "FS_B" };
  const result = preparePlayback(plan, list);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.items.map((item) => item.motion_id), ["FS_A", "FS_B", "HELLO"]);
  assert.deepEqual(result.nonmanual_markers, [{ type: "question_yn", from: 0, to: 1, from_sequence: 0, to_sequence: 2 }]);
});

test("motion loading preserves order and fails explicitly without partial playback", async () => {
  const plan = { ...validPlan(), items: [...validPlan().items, ...validPlan().items] };
  const calls = [];
  const list = catalog(sign("HELLO"));
  const ready = await loadPlayback(plan, list, async (path) => { calls.push(path); return { fixture: path }; });
  assert.equal(ready.status, "ready");
  assert.equal(ready.items.length, 2);
  assert.deepEqual(calls, ["motion/HELLO.json", "motion/HELLO.json"]);
  const failed = await loadPlayback(plan, list, async () => { throw new Error("not found"); });
  assert.equal(failed.status, "unsupported");
  assert.equal(failed.blocked[0].code, "motion_load_failed");
  assert.equal("items" in failed, false);
});

test("alphabet map cannot reuse an unrelated sign as a letter", () => {
  const list = catalog(sign("HELLO"));
  list.fingerspelling = { A: "HELLO" };
  assert.throws(() => assertCatalog(list), /entry with letter A/);
});

test("recognizer label lookup preserves ambiguous senses for user confirmation", () => {
  const list = catalog(sign("RIGHT_CORRECT", { gloss: "RIGHT", sense: "correct", recognizer_label: "right" }),
    sign("RIGHT_DIRECTION", { gloss: "RIGHT", sense: "direction", recognizer_label: "right" }));
  assert.equal(lookupRecognizerLabel("right", list).status, "ambiguous");
  assert.deepEqual(lookupRecognizerLabel("right", list).candidates.map((x) => x.id), ["RIGHT_CORRECT", "RIGHT_DIRECTION"]);
  assert.equal(lookupRecognizerLabel("unknown", list).status, "unknown");
  assert.equal(lookupRecognizerLabel("right", catalog(sign("RIGHT_CORRECT", { recognizer_label: "right" }))).status, "matched");
});

test("checked-in example is valid but blocked by the intentionally empty catalog", () => {
  const plan = JSON.parse(readFileSync(new URL("../examples/sample-plan.json", import.meta.url), "utf8"));
  const list = JSON.parse(readFileSync(new URL("../catalog/signs.json", import.meta.url), "utf8"));
  assert.equal(assertPlan(plan), plan);
  assert.equal(assertCatalog(list), list);
  const result = preparePlayback(plan, list);
  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.blocked.map((x) => x.item_index), [0, 1, 2, 3]);
});
