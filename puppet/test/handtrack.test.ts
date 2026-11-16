import { describe, expect, it } from "vitest";
import { axesOf, basisQ, cleanHandTrack, fillAngles, quatAngleDeg, type Q } from "../src/handtrack";
import { FINGERS, type HandAngles, type V3 } from "../src/hand";
import { concatClips } from "../src/blend";
import { makeMotion } from "./helpers";

const rotY = (deg: number): Q => { const a = (deg * Math.PI) / 360; return [0, Math.sin(a), 0, Math.cos(a)]; };
const flipped = (q: Q): Q => { const { x, y } = axesOf(q); return basisQ(x, [-y[0], -y[1], -y[2]] as V3)!; }; // palm inside out

describe("hand track clean-up", () => {
  it("basisQ and axesOf are inverse", () => {
    const q = basisQ([1, 2, 0.5], [0, 1, -3])!;
    const { x, y } = axesOf(q);
    expect(x[0] / x[1]).toBeCloseTo(0.5, 5);
    expect(x[0] * y[0] + x[1] * y[1] + x[2] * y[2]).toBeCloseTo(0, 6);
  });

  it("rejects a short palm flip and fills it from the neighbours", () => {
    const seq: (Q | null)[] = Array.from({ length: 40 }, (_, i) => rotY(i));
    for (let i = 18; i < 24; i++) seq[i] = flipped(seq[i]!);
    const r = cleanHandTrack(seq, 24);
    expect(r.rejected).toBe(6);
    for (let i = 1; i < 40; i++) expect(quatAngleDeg(r.q[i - 1]!, r.q[i]!)).toBeLessThan(10);
    expect(r.status[20]).toBe("rejected-filled");
    expect(quatAngleDeg(r.q[20]!, rotY(20))).toBeLessThan(5);
  });

  it("fills an untracked span by slerp and holds at clip edges, then lets go", () => {
    const seq: (Q | null)[] = Array.from({ length: 60 }, (_, i) => (i < 10 || (i >= 20 && i < 40) ? rotY(i < 10 ? 0 : 60) : null));
    const r = cleanHandTrack(seq, 24);
    expect(r.status[15]).toBe("filled");
    const mid = quatAngleDeg(r.q[15]!, rotY(0));
    expect(mid).toBeGreaterThan(10); expect(mid).toBeLessThan(50);
    expect(r.status[41]).toBe("held"); // 0.25 s hold after the last tracked frame
    expect(r.q[59]).toBeNull();
  });

  it("limits the turn rate of a real but sudden rotation", () => {
    const seq: (Q | null)[] = Array.from({ length: 80 }, (_, i) => rotY(i < 40 ? 0 : 150));
    const r = cleanHandTrack(seq, 24);
    expect(r.rejected).toBe(0); // both halves are long: not a flip
    for (let i = 1; i < 80; i++) expect(quatAngleDeg(r.q[i - 1]!, r.q[i]!)).toBeLessThanOrEqual(720 / 24 + 1e-6);
  });

  it("fills finger angles on filled frames", () => {
    const a = (v: number) => Object.fromEntries(FINGERS.map((f) => [f, [v, v, v, v]])) as HandAngles;
    const out = fillAngles([a(0), null, null, a(0.3)], ["tracked", "filled", "filled", "tracked"]);
    expect(out[1]!.index[1]).toBeGreaterThan(0);
    expect(out[2]!.index[1]).toBeLessThan(0.3);
  });
});

describe("composition keeps v2 hands", () => {
  it("carries hands3d through the cross-blend and marks the sentence v2", () => {
    const a = makeMotion(10, () => 0.1), b = makeMotion(10, () => 0.2);
    b.version = 2;
    for (const f of b.frames) f.hands3d = { left: null, right: { joints: Array.from({ length: 21 }, () => [0.01, 0.02, 0.03] as [number, number, number]), conf: 0.9 } };
    const { motion } = concatClips([{ motion: a }, { motion: b }], { blend: 0.1, fps: 24 });
    expect(motion.version).toBe(2);
    expect(motion.frames[motion.frames.length - 1].hands3d?.right?.joints).toHaveLength(21);
  });
});
