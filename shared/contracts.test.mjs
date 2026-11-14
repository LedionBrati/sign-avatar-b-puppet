import test from "node:test";
import assert from "node:assert/strict";
import { assertPlan, assertCatalog, resolvePlan } from "./contracts.mjs";

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
  const list = catalog(sign("FS_A"));
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
  const list = catalog(sign("FS_A"), sign("FS_B"), sign("HELLO"));
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
