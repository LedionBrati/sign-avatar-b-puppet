// Synthetic contract fixture only. These IDs and payloads are not valid ASL data.
import { preparePlayback, loadPlayback } from "../shared/contracts.mjs";

const plan = {
  input_text: "Synthetic demo input", caption: "Synthetic demo input",
  items: [{ type: "sign", gloss: "FIXTURE", motion_id: "FIXTURE" }],
  nonmanual_markers: [{ type: "question_yn", from: 0, to: 0 }],
  unsupported_tokens: [],
};
const catalog = {
  schema_version: 1,
  signs: [{ id: "FIXTURE", gloss: "FIXTURE", status: "verified",
    motion_path: "examples/fixtures/fixture.json", source: "synthetic wiring fixture",
    license: "test-only" }],
  fingerspelling: {},
};

const ready = await loadPlayback(plan, catalog, async (path) => ({
  synthetic: true, reference: path, frames: "opaque fixture payload; not ASL or Nikos format",
}));
const blocked = preparePlayback({ ...plan, items: [{ type: "sign", gloss: "MISSING", motion_id: "MISSING" }] }, catalog);
console.log(JSON.stringify({ ready, blocked }, null, 2));
