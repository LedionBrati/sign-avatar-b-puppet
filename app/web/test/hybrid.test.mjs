// HybridPlayer (src/lib/hybrid.ts): one session queue over the clip player and the 3D signer, global indexes.
//   node --experimental-strip-types --test app/web/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { HybridPlayer } from "../src/lib/hybrid.ts";

/** Fake GaplessPlayer: plays appended clips one per tick, reports onIndex like the real one. */
function fakeClips() {
  const c = { items: [], index: -1, onIndex: () => {}, log: [],
    get length() { return c.items.length; },
    append(items) { c.items.push(...items); c.log.push(`append ${items.map((x) => x.url).join(",")}`); if (!c.timer) c.tick(); },
    tick() { c.timer = setTimeout(() => { c.timer = null; if (c.index + 1 < c.items.length) { c.index++; c.onIndex(c.index); c.tick(); } else { c.onIndex(c.items.length); } }, 1); }, // drained: the next append plays from there
    replay() { c.index = -1; c.onIndex(-1); c.tick(); }, stop() { clearTimeout(c.timer); c.timer = null; },
    clear() { c.stop(); c.items = []; c.index = -1; c.onIndex(-1); },
  };
  return c;
}
/** Fake Signer3D: plays every item for a tick. */
function fake3d({ fail = false } = {}) {
  const s = { ready: false, log: [], gen: 0,
    prefetch() {},
    async play(items, { onIndex }) {
      const g = ++s.gen;
      if (fail) throw new Error("no webgl");
      s.ready = true;
      s.log.push(`3d ${items.map((x) => x.motion_id).join(",")}`);
      onIndex(-1);
      for (let k = 0; k < items.length; k++) { await new Promise((r) => setTimeout(r, 1)); if (g !== s.gen) return false; onIndex(k); }
      return g === s.gen;
    },
    stop() { s.gen++; },
  };
  return s;
}
const it = (id, clip = true) => ({ motion_id: id, gloss: id, url: clip ? `/clips/${id}.mp4` : "", motion_url: `/motion/${id}.json`, duration_s: 1, word_index: 0 });
const until = (p, pred) => new Promise((resolve) => { const t = setInterval(() => { if (pred()) { clearInterval(t); resolve(); } }, 2); });

test("clips, then a 3D phrase, then clips: global indexes, one style per phrase, crossfade events", async () => {
  const clips = fakeClips(), s = fake3d();
  const h = new HybridPlayer(clips, () => s);
  const seen = [], modes = [];
  h.onIndex = (i) => seen.push(i);
  h.onMode = (m) => modes.push(m);
  h.append([it("A"), it("B")], "clips");
  h.append([it("C", false), it("D")], "3d", "/motion/neutral.json");
  h.append([it("E")], "clips");
  assert.equal(h.length, 5);
  await until(h, () => seen.at(-1) === 5);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(modes, ["3d", "clips"]);
  assert.deepEqual(s.log, ["3d C,D"]);
  assert.deepEqual(clips.log, ["append /clips/A.mp4,/clips/B.mp4", "append /clips/E.mp4"]);
});

test("consecutive clip phrases share one gapless run; a phrase after the queue drained starts it again", async () => {
  const clips = fakeClips(), s = fake3d();
  const h = new HybridPlayer(clips, () => s);
  const seen = [];
  h.onIndex = (i) => seen.push(i);
  h.append([it("A")], "clips");
  h.append([it("B")], "clips");
  await until(h, () => seen.at(-1) === 2);
  h.append([it("C", false)], "3d");
  await until(h, () => seen.at(-1) === 3);
  assert.deepEqual(seen, [0, 1, 2, 2, 3]);
});

test("the 3D signer can't load: a phrase with every clip falls back to photoreal, others are skipped", async () => {
  const clips = fakeClips(), s = fake3d({ fail: true });
  const h = new HybridPlayer(clips, () => s);
  const seen = [];
  h.onIndex = (i) => seen.push(i);
  h.append([it("A"), it("B")], "3d");   // Always 3D, but WebGL failed
  h.append([it("C", false)], "3d");     // no clip: captions only
  await until(h, () => seen.at(-1) === 3);
  assert.deepEqual(seen, [0, 1, 3]);
  assert.deepEqual(clips.log, ["append /clips/A.mp4,/clips/B.mp4"]);
});

test("replay plays the whole session again; clear resets indexes", async () => {
  const clips = fakeClips(), s = fake3d();
  const h = new HybridPlayer(clips, () => s);
  const seen = [];
  h.onIndex = (i) => seen.push(i);
  h.append([it("A")], "clips");
  h.append([it("B", false)], "3d");
  await until(h, () => seen.at(-1) === 2);
  seen.length = 0;
  h.replay();
  await until(h, () => seen.at(-1) === 2);
  assert.deepEqual(seen.filter((i) => i >= 0), [0, 1, 2]);
  h.clear();
  assert.equal(h.length, 0);
  assert.equal(seen.at(-1), -1);
});
