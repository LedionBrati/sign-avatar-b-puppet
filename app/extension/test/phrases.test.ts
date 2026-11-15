// node --experimental-strip-types --test test/phrases.test.ts   (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { PhraseAssembler, cueAt, cuesFromTranscript, parseClock, stripAnnotations } from "../lib/phrases.ts";

function run(frames: [number, string][], end: number, o = {}) {
  const out: string[] = [];
  const a = new PhraseAssembler((t) => out.push(t), o);
  for (const [t, text] of frames) { a.tick(t); a.update(text, t); }
  for (let t = frames.at(-1)![0]; t <= end; t += 100) a.tick(t);
  return out;
}

test("rolling auto-captions: growing + scrolling lines become phrases, no repeats", () => {
  const out = run([
    [0, "so in"], [300, "so in college"], [600, "so in college I was"], [900, "so in college I was a government"],
    [1200, "a government major which"], [1500, "a government major which means I"], [1800, "major which means I had to write"],
    [2100, "major which means I had to write a lot of papers"],
  ], 4000);
  assert.deepEqual(out.join(" "), "so in college I was a government major which means I had to write a lot of papers");
  assert.ok(out.length >= 1);
});

test("sentence ends flush immediately; the rest waits for a pause", () => {
  const out = run([[0, "Hello, thank you."], [200, "Hello, thank you. See you"], [400, "thank you. See you later"]], 2000);
  assert.deepEqual(out, ["Hello, thank you.", "See you later"]);
});

test("pop-on captions (whole lines replaced) each become a phrase after a pause", () => {
  const out = run([[0, "Now, when a normal student"], [1000, "writes a paper, they might"], [2000, "spread the work out."]], 3500);
  assert.deepEqual(out, ["Now, when a normal student", "writes a paper, they might", "spread the work out."]);
});

test("long run-on captions are cut at maxWords (at a comma when possible)", () => {
  const long = "one two three four five, six seven eight nine ten eleven twelve thirteen fourteen fifteen";
  const out = run([[0, long]], 100, { maxWords: 10 });
  assert.equal(out[0], "one two three four five,");
});

test("recogniser revising its last word does not duplicate the line", () => {
  const out = run([[0, "I was a govern"], [300, "I was a government major"]], 2000);
  assert.deepEqual(out, ["I was a government major"]);
});

test("re-rendered identical captions and annotations are ignored", () => {
  const out = run([[0, "[Music]"], [300, "Hello there"], [600, "Hello there"], [900, "(Laughter) Hello there"]], 2500);
  assert.deepEqual(out, ["Hello there"]);
  assert.equal(stripAnnotations("♪ la la ♪ (Applause) >> Okay"), "Okay");
});

test("transcript segments -> sentence cues with shared-out time; cueAt binary search", () => {
  const cues = cuesFromTranscript([
    { start: 12, text: "So in college, I was a government major, which means I had to write a lot of papers." },
    { start: 19, text: "Now, when a normal student writes a paper. They might spread the work out." },
    { start: 23, text: "(Laughter)" },
    { start: 25, text: "And I would want to do that." },
  ]);
  assert.deepEqual(cues.map((c) => c.text), [
    "So in college, I was a government major, which means I had to write a lot of papers.",
    "Now, when a normal student writes a paper.", "They might spread the work out.", "And I would want to do that.",
  ]);
  assert.equal(cues[1]!.start, 19);
  assert.ok(cues[2]!.start > 19 && cues[2]!.start < 23);
  assert.equal(cueAt(cues, 5), -1);
  assert.equal(cueAt(cues, 12), 0);
  assert.equal(cueAt(cues, 22.9), 2);
  assert.equal(cueAt(cues, 999), 3);
});

test("parseClock", () => {
  assert.equal(parseClock("0:12"), 12);
  assert.equal(parseClock("1:02:03"), 3723);
  assert.ok(Number.isNaN(parseClock("abc")));
});
