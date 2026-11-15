// Opt-in check against a genuine, locally held extractor output. No ASL asset is committed.
// This tests technical compatibility only; it does not grant rights or signer QA status.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadPlayback } from "./contracts.mjs";
import { createMotionLoader } from "./motion-loader.node.mjs";
import { assertMotionV1 } from "./motion-format.mjs";

const root = process.env.ASL_REAL_MOTION_ROOT;
const motionPath = process.env.ASL_REAL_MOTION_PATH;
const id = process.env.ASL_REAL_MOTION_ID;
const gloss = process.env.ASL_REAL_MOTION_GLOSS;

test("real isolated motion loads unchanged through the shared playback contract", {
  skip: !root || !motionPath || !id || !gloss ? "set ASL_REAL_MOTION_ROOT/PATH/ID/GLOSS" : false,
}, async () => {
  const original = JSON.parse(await readFile(join(root, motionPath), "utf8"));
  const stem = basename(motionPath, ".clean.json");
  assertMotionV1(original, { expectedMotionId: id, requireClean: true, fileStem: stem });
  assert.equal(original.gloss, gloss);
  assert.ok(original.frames.some((frame) => frame.leftHand || frame.rightHand), "no tracked hand in the clip");

  // In-memory verified entry is a wiring fixture only. Do not commit it to the real catalog.
  const catalog = { schema_version: 1, signs: [{ id, gloss, status: "verified",
    motion_path: motionPath, source: original.source.file, license: original.source.license }],
    fingerspelling: {} };
  const plan = { input_text: gloss, caption: gloss, items: [{ type: "sign", gloss, motion_id: id }],
    nonmanual_markers: [], unsupported_tokens: [] };
  const result = await loadPlayback(plan, catalog, createMotionLoader({ root }));
  assert.equal(result.status, "ready", JSON.stringify(result.blocked));
  assert.deepEqual(result.items[0].motion, original);
});
