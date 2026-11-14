import { describe, expect, it } from "vitest";
import { concatClips, ease, lerpFrame, lerpPoints, retime, sampleAt } from "../src/blend";
import { validateMotion } from "../src/motion";
import { makeMotion } from "./helpers";

describe("lerpPoints / lerpFrame", () => {
  it("interpolates and falls back to the other side when one is null", () => {
    expect(lerpPoints([[0, 0, 0]], [[2, 4, 6]], 0.5)).toEqual([[1, 2, 3]]);
    expect(lerpPoints(null, [[2, 4, 6]], 0.5)).toEqual([[2, 4, 6]]);
    expect(lerpPoints([[1, 1, 1]], null, 0.5)).toEqual([[1, 1, 1]]);
    expect(lerpPoints(null, null, 0.5)).toBeNull();
  });
  it("blends every part of a frame", () => {
    const m = makeMotion(2, (i) => i * 10);
    const f = lerpFrame(m.frames[0], m.frames[1], 0.25);
    expect(f.rightHand![0][0]).toBeCloseTo(2.5);
    expect(f.pose![11][3]).toBe(1);
    expect(f.face![477][2]).toBeCloseTo(2.5);
  });
});

describe("retime", () => {
  const m = makeMotion(25, (i) => i); // 1 s from first to last frame
  it("keeps length at speed 1 and halves it at speed 2", () => {
    expect(retime({ motion: m }, 24)).toHaveLength(25);
    const fast = retime({ motion: m, speed: 2 }, 24);
    expect(fast).toHaveLength(13);
    expect(fast[1].leftHand![0][0]).toBeCloseTo(2);
    expect(fast[12].leftHand![0][0]).toBeCloseTo(24);
  });
  it("adds holds by freezing the first and last frame", () => {
    const held = retime({ motion: m, holdStart: 0.5, holdEnd: 0.25 }, 24);
    expect(held).toHaveLength(25 + 12 + 6);
    expect(held[11].leftHand![0][0]).toBe(0);
    expect(held[12].leftHand![0][0]).toBe(0);
    expect(held[13].leftHand![0][0]).toBeCloseTo(1);
    expect(held[held.length - 1].leftHand![0][0]).toBe(24);
  });
  it("samples between frames", () => {
    expect(sampleAt(m, 0.5 / 24).leftHand![0][0]).toBeCloseTo(0.5);
  });
  it("rejects a non-positive speed", () => {
    expect(() => retime({ motion: m, speed: 0 }, 24)).toThrow();
  });
});

describe("concatClips", () => {
  const a = makeMotion(24, () => 0, { name: "A", gloss: "HELLO" });
  const b = makeMotion(24, () => 1, { name: "B", gloss: "NAME" });
  it("overlaps by the blend length and eases from A to B", () => {
    const { motion, segments } = concatClips([{ motion: a }, { motion: b }], { blend: 0.2 });
    const overlap = Math.round(0.2 * 24); // 5 frames
    expect(motion.frames).toHaveLength(48 - overlap);
    expect(motion.gloss).toBe("HELLO NAME");
    expect(segments.map((s) => [s.name, s.start, s.end])).toEqual([["A", 0, 23], ["B", 24 - overlap, 48 - overlap - 1]]);
    const v = motion.frames.map((f) => f.rightHand![0][0]);
    expect(v[24 - overlap - 1]).toBe(0); // last pure A frame
    for (let k = 24 - overlap; k < 24; k++) { expect(v[k]).toBeGreaterThan(v[k - 1]); expect(v[k]).toBeLessThan(1); }
    expect(v[24]).toBe(1); // first pure B frame
    expect(motion.frames.every((f, i) => f.i === i && Math.abs(f.t - i / 24) < 1e-4)).toBe(true);
    expect(() => validateMotion(motion)).not.toThrow();
  });
  it("blend 0 is a hard cut", () => {
    const { motion } = concatClips([{ motion: a }, { motion: b }], { blend: 0 });
    expect(motion.frames).toHaveLength(48);
    expect(motion.frames[23].rightHand![0][0]).toBe(0);
    expect(motion.frames[24].rightHand![0][0]).toBe(1);
  });
  it("clamps the overlap for very short clips", () => {
    const tiny = makeMotion(4, () => 1);
    const { motion } = concatClips([{ motion: a }, { motion: tiny }], { blend: 1 });
    expect(motion.frames).toHaveLength(24 + 4 - 2);
  });
  it("ease is a smoothstep", () => {
    expect(ease(0)).toBe(0); expect(ease(1)).toBe(1); expect(ease(0.5)).toBe(0.5); expect(ease(-1)).toBe(0); expect(ease(0.25)).toBeLessThan(0.25);
  });
});
