import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syntheticMotion } from "./fixtures/synthetic-motion.mjs";

const script = fileURLToPath(new URL("./check-playback.mjs", import.meta.url));
const plan = { input_text: "synthetic non-ASL test", caption: "synthetic non-ASL test",
  items: [{ type: "sign", gloss: "SYNTHETIC", motion_id: "SYNTHETIC" }],
  nonmanual_markers: [], unsupported_tokens: [] };
const catalog = { schema_version: 1, signs: [{ id: "SYNTHETIC", gloss: "SYNTHETIC",
  status: "verified", motion_path: "SYNTHETIC.clean.json", source: "synthetic test fixture",
  license: "test-only" }], fingerspelling: {} };

async function run({ motion = syntheticMotion(), planValue = plan } = {}) {
  const root = await mkdtemp(join(tmpdir(), "playback-smoke-"));
  await writeFile(join(root, "plan.json"), JSON.stringify(planValue));
  await writeFile(join(root, "catalog.json"), JSON.stringify(catalog));
  await writeFile(join(root, "SYNTHETIC.clean.json"), JSON.stringify(motion));
  return spawnSync(process.execPath, [script, join(root, "plan.json"), join(root, "catalog.json"), root],
    { encoding: "utf8" });
}

test("smoke CLI loads one synthetic non-ASL v1 file through loadPlayback", async () => {
  const result = await run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "ready");
  assert.equal(report.items[0].motion_id, "SYNTHETIC");
  assert.equal(report.items[0].frames, 2);
  assert.equal(report.items[0].fps, 24);
  assert.equal(report.items[0].detected_frames.left_hand, 1);
  assert.equal(report.items[0].detected_frames.right_hand, 1);
});

test("smoke CLI blocks a sentence clip and never reports it playable", async () => {
  const result = await run({ motion: syntheticMotion({ sentence: true }) });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "unsupported");
  assert.equal(report.blocked[0].code, "motion_load_failed");
  assert.equal(report.items, undefined);
});

test("smoke CLI preserves all-or-nothing behavior with an unknown second sign", async () => {
  const planValue = { ...plan, items: [...plan.items, { type: "sign", gloss: "MISSING", motion_id: "MISSING" }] };
  const result = await run({ planValue });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "unsupported");
  assert.equal(report.blocked[0].code, "unknown_sign");
  assert.equal(report.items, undefined);
});
