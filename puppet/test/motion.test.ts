import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { duration, frameAt, frameIndexAt, missingStats, MotionError, validateMotion } from "../src/motion";
import { makeMotion } from "./helpers";

describe("validateMotion", () => {
  it("accepts the synthetic fixture", () => {
    const json = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/wave.json"), "utf8"));
    const { motion, warnings } = validateMotion(json);
    expect(motion.frames.length).toBe(72);
    expect(warnings).toEqual([]);
    expect(missingStats(motion).leftHand).toBe(11); // frames 30-40 have the left hand lost
  });

  it("allows null parts and fills missing optional ones with null", () => {
    const m = makeMotion(3, () => 0.5) as any;
    m.frames[1].leftHand = null;
    delete m.frames[2].face;
    const { motion } = validateMotion(m);
    expect(motion.frames[1].leftHand).toBeNull();
    expect(motion.frames[2].face).toBeNull();
  });

  it("rejects wrong version, wrong point counts and non-finite numbers, listing every problem", () => {
    const m = makeMotion(3, () => 0.5) as any;
    m.version = 3;
    m.frames[0].rightHand = m.frames[0].rightHand.slice(0, 20);
    m.frames[1].pose[3][1] = NaN;
    let err: unknown;
    try { validateMotion(m); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MotionError);
    const p = (err as MotionError).problems.join("\n");
    expect(p).toMatch(/version/);
    expect(p).toMatch(/rightHand: expected 21 points, got 20/);
    expect(p).toMatch(/frames\[1\]\.pose\[3\]: non-finite/);
  });

  it("accepts v2 (v1 + hands3d) and checks the hands3d joints", () => {
    const m = makeMotion(2, () => 0.5) as any;
    m.version = 2;
    m.frames[0].hands3d = { left: null, right: { joints: Array.from({ length: 21 }, () => [0, 0, 0]), conf: 0.8 } };
    expect(validateMotion(m).motion.frames[0].hands3d?.right?.joints).toHaveLength(21);
    m.frames[1].hands3d = { left: { joints: [[0, 0, 0]] }, right: null };
    expect(() => validateMotion(m)).toThrow(/hands3d\.left\.joints/);
  });

  it("accepts files with or without motion_id, rejects a non-string one", () => {
    const without = makeMotion(2, () => 0.5) as any;
    expect(validateMotion(without).motion.motion_id).toBeNull();
    expect(validateMotion({ ...makeMotion(2, () => 0.5), motion_id: "THANK_YOU" }).motion.motion_id).toBe("THANK_YOU");
    expect(() => validateMotion({ ...makeMotion(2, () => 0.5), motion_id: 3 })).toThrow(/motion_id/);
  });

  it("rejects time going backwards and an empty frame list", () => {
    const m = makeMotion(3, () => 0.5) as any;
    m.frames[2].t = 0;
    expect(() => validateMotion(m)).toThrow(/backwards/);
    expect(() => validateMotion({ ...m, frames: [] })).toThrow(/non-empty/);
  });
});

describe("frame lookup", () => {
  const m = makeMotion(10, (i) => i); // 24 fps
  it("finds the frame showing at time t", () => {
    expect(frameIndexAt(m, -1)).toBe(0);
    expect(frameIndexAt(m, 0)).toBe(0);
    expect(frameIndexAt(m, 1 / 24 - 0.001)).toBe(0);
    expect(frameIndexAt(m, 1 / 24)).toBe(1);
    expect(frameIndexAt(m, 5.5 / 24)).toBe(5);
    expect(frameIndexAt(m, 100)).toBe(9);
    expect(frameAt(m, 3 / 24).i).toBe(3);
  });
  it("reports duration including the last frame", () => {
    expect(duration(m)).toBeCloseTo(10 / 24);
  });
});
