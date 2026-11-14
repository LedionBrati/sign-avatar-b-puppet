import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMotionV1, MotionValidationError } from "./motion-format.mjs";
import { createMotionLoader, auditVerifiedCatalog } from "./motion-loader.node.mjs";
import { loadPlayback } from "./contracts.mjs";
import { syntheticMotion } from "./fixtures/synthetic-motion.mjs";

const plan = { input_text: "synthetic non-ASL test", caption: "synthetic non-ASL test",
  items: [{ type: "sign", gloss: "SYNTHETIC", motion_id: "SYNTHETIC" }],
  nonmanual_markers: [], unsupported_tokens: [] };
const catalog = (path = "SYNTHETIC.clean.json") => ({ schema_version: 1,
  signs: [{ id: "SYNTHETIC", gloss: "SYNTHETIC", status: "verified", motion_path: path,
    source: "synthetic test fixture", license: "test-only" }], fingerspelling: {} });

test("v1 accepts raw and cleaned motion with whole-part and per-point nulls", () => {
  const clean = syntheticMotion();
  clean.frames[0].pose[0] = null;
  clean.frames[1].leftHand[4] = null;
  assert.equal(assertMotionV1(clean, { expectedMotionId: "SYNTHETIC", requireClean: true }), clean);
  assert.equal(clean.frames[0].pose[0], null);
  const raw = syntheticMotion({ cleaned: false });
  assert.equal(assertMotionV1(raw), raw);
  assert.throws(() => assertMotionV1(raw, { requireClean: true }), /requires cleaned motion/);
});

test("v1 rejects invalid header, timestamps, landmark dimensions and scores", () => {
  const motion = syntheticMotion();
  motion.version = 2; motion.fps = 0; motion.source.license = "";
  motion.frames[1].i = 3; motion.frames[1].t = 4;
  motion.frames[0].pose.pop(); motion.frames[0].face[0] = [0, 0];
  motion.frames[0].rightHand[0] = [Number.NaN, 0, 0];
  motion.frames[0].faceBlendshapes.browInnerUp = 2;
  assert.throws(() => assertMotionV1(motion), (error) =>
    error instanceof MotionValidationError &&
    ["version", "fps", "source.license", "frames[1].i", "frames[0].pose", "frames[0].face[0]",
      "frames[0].rightHand[0]", "faceBlendshapes"].every((word) => error.message.includes(word)));
});

test("a sentence clip is valid reference data but cannot satisfy an isolated sign", () => {
  const sentence = syntheticMotion({ sentence: true });
  assert.equal(assertMotionV1(sentence), sentence);
  assert.throws(() => assertMotionV1(sentence, { expectedMotionId: "SYNTHETIC" }), /sentence\/reference clip/);
});

test("Node loader reads a .clean.json file and loadPlayback keeps the public API", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-loader-"));
  const motion = syntheticMotion();
  await writeFile(join(root, "SYNTHETIC.clean.json"), JSON.stringify(motion));
  const loader = createMotionLoader({ root });
  const loaded = await loader("SYNTHETIC.clean.json", { motion_id: "SYNTHETIC", gloss: "SYNTHETIC" });
  assert.deepEqual(loaded, motion);
  const result = await loadPlayback(plan, catalog(), loader);
  assert.equal(result.status, "ready");
  assert.equal(result.items[0].motion.version, 1);
  assert.equal(result.items[0].motion.frames[1].rightHand, null);
  assert.deepEqual(await auditVerifiedCatalog(catalog(), { root }), { valid: true, checked: 1, failures: [] });
});

test("loader rejects raw files, mismatched IDs and sentence files in a verified catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-invalid-"));
  await writeFile(join(root, "SYNTHETIC.raw.json"), JSON.stringify(syntheticMotion({ cleaned: false })));
  await writeFile(join(root, "SYNTHETIC.clean.json"), JSON.stringify(syntheticMotion({ sentence: true })));
  const loader = createMotionLoader({ root });
  await assert.rejects(loader("SYNTHETIC.raw.json", { motion_id: "SYNTHETIC" }), /\.clean\.json/);
  const blocked = await loadPlayback(plan, catalog(), loader);
  assert.equal(blocked.status, "unsupported");
  assert.equal(blocked.blocked[0].code, "motion_load_failed");
  assert.match(blocked.blocked[0].reason, /motion_id:null/);
  const audit = await auditVerifiedCatalog(catalog(), { root });
  assert.equal(audit.valid, false);
  assert.match(audit.failures[0].error, /sentence\/reference clip/);
  await writeFile(join(root, "SYNTHETIC.clean.json"), JSON.stringify({ ...syntheticMotion(), motion_id: "OTHER" }));
  await assert.rejects(loader("SYNTHETIC.clean.json", { motion_id: "SYNTHETIC" }), /does not match expected/);
});

test("loader prevents traversal and a symlink escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-root-"));
  const outside = await mkdtemp(join(tmpdir(), "motion-outside-"));
  await writeFile(join(outside, "SYNTHETIC.clean.json"), JSON.stringify(syntheticMotion()));
  await symlink(join(outside, "SYNTHETIC.clean.json"), join(root, "SYNTHETIC.clean.json"));
  const loader = createMotionLoader({ root });
  await assert.rejects(loader("../SYNTHETIC.clean.json", { motion_id: "SYNTHETIC" }), /escapes project root/);
  await assert.rejects(loader("SYNTHETIC.clean.json", { motion_id: "SYNTHETIC" }), /symlink escapes/);
});

test("loader reports missing, malformed and mislabeled cleaned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "motion-errors-"));
  const loader = createMotionLoader({ root });
  await assert.rejects(loader("MISSING.clean.json", { motion_id: "SYNTHETIC" }), /cannot access motion MISSING\.clean\.json/);
  await assert.rejects(loader(join(root, "SYNTHETIC.clean.json"), { motion_id: "SYNTHETIC" }), /project-relative/);
  await writeFile(join(root, "SYNTHETIC.clean.json"), "{not json");
  await assert.rejects(loader("SYNTHETIC.clean.json", { motion_id: "SYNTHETIC" }), /cannot read JSON/);
  await writeFile(join(root, "SYNTHETIC.clean.json"), JSON.stringify({ ...syntheticMotion(), name: "OTHER" }));
  await assert.rejects(loader("SYNTHETIC.clean.json", { motion_id: "SYNTHETIC" }), /name must match file stem/);
  await writeFile(join(root, "SYNTHETIC.clean.json"), JSON.stringify({ ...syntheticMotion(), cleaned: false, cleanup: null }));
  await assert.rejects(loader("SYNTHETIC.clean.json", { motion_id: "SYNTHETIC" }), /requires cleaned motion/);
});
