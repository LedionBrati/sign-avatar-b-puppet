// Production clip folders (pipeline/produce.mjs -> out/realtime/clips-v2-<set>) win over the old clips for the same sign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverV2Dirs, loadClipSets, withV2Clips } from "../lib/clips.mjs";

function setDir(root, name, entries) {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  const manifest = {};
  for (const id of entries) { writeFileSync(join(d, `${id}.mp4`), "x"); manifest[id] = { gloss: id.replace(/_/g, " "), file: `${id}.mp4`, frames: 24, seconds: 1 }; }
  writeFileSync(join(d, "manifest.json"), JSON.stringify(manifest));
  return d;
}

test("clips-v2-demo, -sentences, -library go first, in that order; variants are not picked up", () => {
  const root = mkdtempSync(join(tmpdir(), "v2-"));
  const old = setDir(root, "clips", ["HELLO", "THANK_YOU", "DEAF"]);
  const mass = setDir(root, "clips-mass", ["TO"]);
  const lib = setDir(root, "clips-v2-library", ["HELLO", "TO"]);
  const demo = setDir(root, "clips-v2-demo", ["HELLO"]);
  setDir(root, "clips-v2-library-ltx_r2r", ["HELLO"]);
  const dirs = withV2Clips([old, mass], {}, { roots: [] });
  assert.deepEqual(dirs, [demo, lib, old, mass]);
  assert.deepEqual(discoverV2Dirs([old], { roots: [] }), [demo, lib]);
  const sets = loadClipSets(dirs);
  assert.equal(sets.signs.get("HELLO").dir, demo, "the demo take wins");
  assert.equal(sets.signs.get("TO").dir, lib, "the library beats clips-mass");
  assert.equal(sets.signs.get("DEAF").dir, old, "signs without a v2 clip still come from the old set");
  assert.deepEqual(withV2Clips([old], { CLIPS_V2: "0" }, { roots: [] }), [old], "CLIPS_V2=0 turns it off");
  assert.deepEqual(withV2Clips([old, lib], {}, { roots: [] }), [old, lib], "an explicit clips-v2 dir keeps the given order");
});
