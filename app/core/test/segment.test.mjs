// app/core/src/segment.ts cuts the shared fixture exactly like app/recognizer/segment.py
// (fixture written by: app/recognizer/.venv/Scripts/python app/recognizer/tests/test_segment.py --write).
//   node --experimental-strip-types --test app/core/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SEG, createCutter, cutStream } from "../src/segment.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/segment-fixture.json", import.meta.url), "utf8"));
const LH = 468, RH = 522, POSE = 489;

function unpack(rows) {
  return rows.map((r) => {
    const f = new Float32Array(543 * 3).fill(NaN);
    for (const [key, start] of [["pose11", POSE + 11], ["pose12", POSE + 12], ["lh", LH], ["rh", RH]]) {
      (r[key] ?? []).forEach(([x, y], k) => { f[(start + k) * 3] = x; f[(start + k) * 3 + 1] = y; f[(start + k) * 3 + 2] = 0; });
    }
    return f;
  });
}

test("same numbers as segment.py", () => {
  assert.deepEqual(SEG, fx.config);
});

test("same cuts as segment.py on the fixture", () => {
  const cuts = cutStream(unpack(fx.frames), fx.fps).map((c) => [c.start, c.end, c.reason]);
  assert.deepEqual(cuts, fx.cuts);
});

test("still hands never start a segment", () => {
  const f = unpack([{ pose11: [[0.625, 0.45]], pose12: [[0.375, 0.45]], lh: null, rh: Array.from({ length: 21 }, (_, k) => [0.35 + k * 0.002, 0.55 - k * 0.003]) }])[0];
  const c = createCutter();
  for (let i = 0; i < 90; i++) assert.equal(c.push(f, i * 33).started, false);
  assert.equal(c.state, "armed");
});
