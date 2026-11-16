// Playback rule, slim-motion inflater and the 3D engine's phrase -> playlist index mapping (app/core/src/signer3d.ts).
//   node --experimental-strip-types --test app/core/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Signer3D, choosePlayback, inflateMotion } from "../src/signer3d.ts";

const item = (id, url, motion_url) => ({ motion_id: id, gloss: id, url, duration_s: 1, word_index: 0, ...(motion_url ? { motion_url } : {}) });

test("every sign has a clip -> photoreal clips", () => {
  assert.equal(choosePlayback({ playlist: [item("A", "/clips/A.mp4", "/motion/a.json"), item("B", "/clips/B.mp4")] }), "clips");
});

test("one sign without a clip -> the WHOLE phrase in 3D (never mixed)", () => {
  assert.equal(choosePlayback({ playlist: [item("A", "/clips/A.mp4", "/motion/a.json"), item("B", "", "/motion/b.json")] }), "3d");
});

test("Always 3D plays clip phrases in 3D when every sign has motion, else clips", () => {
  const both = { playlist: [item("A", "/clips/A.mp4", "/motion/a.json"), item("B", "/clips/B.mp4", "/motion/b.json")] };
  assert.equal(choosePlayback(both, { always3d: true }), "3d");
  assert.equal(choosePlayback(both), "clips");
  const clipOnly = { playlist: [item("A", "/clips/A.mp4", "/motion/a.json"), item("B", "/clips/B.mp4")] };
  assert.equal(choosePlayback(clipOnly, { always3d: true }), "clips");
});

test("a sign with neither, or nothing to sign -> captions only", () => {
  assert.equal(choosePlayback({ playlist: [item("A", "", "/motion/a.json"), item("B", "/clips/B.mp4")] }), "none");
  assert.equal(choosePlayback({ playlist: [] }), "none");
  assert.equal(choosePlayback({ playlist: [] }, { always3d: true }), "none");
});

test("inflateMotion puts the face subset back at its MediaPipe indices", () => {
  const subset = [1, 10, 33];
  const m = { face_subset: subset, frames: [{ face: [[0.1, 0.1, 0], [0.2, 0.2, 0], [0.3, 0.3, 0]] }, { face: null }] };
  inflateMotion(m);
  assert.equal(m.face_subset, undefined);
  assert.equal(m.frames[0].face.length, 478);
  assert.deepEqual(m.frames[0].face[1], [0.1, 0.1, 0]);
  assert.deepEqual(m.frames[0].face[10], [0.2, 0.2, 0]);
  assert.deepEqual(m.frames[0].face[33], [0.3, 0.3, 0]);
  assert.deepEqual(m.frames[0].face[200], [0.1, 0.1, 0]); // filler = nose tip
  assert.equal(m.frames[1].face, null);
  const plain = { frames: [{ face: [[1, 2, 3]] }] };
  assert.equal(inflateMotion(plain).frames[0].face.length, 1); // full files are left alone
});

/** A fake SignerPlayer: segments of 10 frames each (like concatClips), play() walks the frames synchronously. */
function fakeModule(log) {
  return {
    SignerPlayer: {
      async create(_canvas, opts) {
        log.push(`create ${opts.modelUrl}`);
        let n = 0, stopped = false;
        return {
          loadSentence(motions) { n = motions.length; log.push(`load ${motions.map((m) => m.name).join(" ")}`); return { frames: n * 10, fps: 25, segments: motions.map((m, k) => ({ start: k * 10, end: k * 10 + 9, gloss: m.name })) }; },
          async play({ onFrame }) { stopped = false; for (let f = 0; f < n * 10 && !stopped; f++) { onFrame(f, null); if (f % 10 === 9) await new Promise((r) => setTimeout(r, 5)); } },
          stop() { stopped = true; log.push("stop"); },
          seek(f) { log.push(`seek ${f}`); },
        };
      },
    },
  };
}
const fakeFetch = (fetched) => async (url) => {
  fetched.push(url);
  const name = url.split("/").pop().replace(".json", "");
  return { ok: name !== "missing", status: name === "missing" ? 404 : 200, json: async () => ({ name, face_subset: [1], frames: [{ face: [[0, 0, 0]] }] }) };
};

test("Signer3D: bundle + avatar load once, motions fetched once, rest -> signs -> rest, onIndex per sign", async () => {
  const log = [], fetched = [];
  let loads = 0;
  const s = new Signer3D({ load: async () => { loads++; return fakeModule(log); }, modelUrl: "http://h/models/signer.glb", canvas: {}, fetch: fakeFetch(fetched) });
  const seen = [];
  const items = [{ motion_url: "http://h/motion/a.json" }, { motion_url: "http://h/motion/b.json" }];
  assert.equal(await s.play(items, { restUrl: "http://h/motion/neutral.json", onIndex: (i) => seen.push(i) }), true);
  assert.deepEqual(seen, [-1, 0, 1]); // rest (no sign), then A from frame 10, B from frame 20; rest-out keeps B
  assert.ok(log.includes("load neutral a b neutral"));
  await s.play(items, { restUrl: "http://h/motion/neutral.json" });
  assert.equal(loads, 1);
  assert.equal(log.filter((l) => l.startsWith("create")).length, 1);
  assert.deepEqual([...new Set(fetched)].length, fetched.length); // each motion once
  assert.equal(s.ready, true);
});

test("Signer3D: a newer play() cancels the running one; a missing motion throws; stop() resolves false", async () => {
  const log = [];
  const s = new Signer3D({ load: async () => fakeModule(log), modelUrl: "m", canvas: {}, fetch: fakeFetch([]) });
  const first = s.play([{ motion_url: "/motion/a.json" }, { motion_url: "/motion/b.json" }, { motion_url: "/motion/c.json" }]);
  const second = s.play([{ motion_url: "/motion/b.json" }]);
  assert.equal(await first, false);
  assert.equal(await second, true);
  await assert.rejects(s.play([{ motion_url: "/motion/missing.json" }]), /HTTP 404/);
  await assert.rejects(s.play([{}]), /motion_url/);
  const p = s.play([{ motion_url: "/motion/a.json" }, { motion_url: "/motion/b.json" }, { motion_url: "/motion/c.json" }]);
  await new Promise((r) => setTimeout(r, 0));
  s.stop();
  assert.equal(await p, false);
});

test("Signer3D: a failed avatar load is retried on the next call", async () => {
  let n = 0;
  const s = new Signer3D({ load: async () => { if (n++ === 0) throw new Error("offline"); return fakeModule([]); }, modelUrl: "m", canvas: {}, fetch: fakeFetch([]) });
  await assert.rejects(s.warm(), /offline/);
  await s.warm();
  assert.equal(s.ready, true);
});
