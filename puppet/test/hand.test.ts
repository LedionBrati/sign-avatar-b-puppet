import { describe, expect, it } from "vitest";
import {
  FINGERS, FINGER_LM, LIMITS, OneEuro, countOverlaps, countViolations, fk, geomFromPoints, palmFrame, readAngles,
  smoothSequence, solveHand, toLocal, type Finger, type HandAngles, type V3,
} from "../src/hand";

const D = Math.PI / 180;
/** a right hand in palm-local axes (x toward the index, y wrist -> middle knuckle, z out of the palm), metres */
const BASE: Record<Finger, V3> = {
  thumb: [0.022, 0.02, 0.008], index: [0.024, 0.088, 0], middle: [0, 0.09, 0], ring: [-0.017, 0.084, 0], pinky: [-0.034, 0.074, 0],
};
const LEN: Record<Finger, [number, number, number]> = {
  thumb: [0.04, 0.032, 0.028], index: [0.043, 0.025, 0.02], middle: [0.047, 0.029, 0.021], ring: [0.044, 0.028, 0.021], pinky: [0.034, 0.02, 0.019],
};
const GEOM = { palm: Math.hypot(...BASE.middle), base: BASE, lengths: LEN };

function handFrom(a: HandAngles): V3[] {
  const pts: V3[] = new Array(21);
  pts[0] = [0, 0, 0];
  for (const f of FINGERS) fk(GEOM, f, a[f]).pts.forEach((p, j) => { pts[FINGER_LM[f][j]] = p; });
  return pts;
}
const deg = (o: Record<Finger, number[]>): HandAngles => Object.fromEntries(FINGERS.map((f) => [f, o[f].map((v) => v * D)])) as HandAngles;

describe("hand solver", () => {
  it("reads back the angles it was built from", () => {
    const a = deg({ thumb: [40, 25, 30, 20], index: [10, 5, 10, 5], middle: [-5, 60, 80, 40], ring: [-8, 70, 90, 50], pinky: [-15, 80, 95, 60] });
    const pts = handFrom(a);
    const F = palmFrame(pts, "right")!;
    const r = readAngles(pts.map((p) => toLocal(F, p)));
    for (const f of FINGERS) for (let k = 0; k < 4; k++) expect([f, k, Math.abs(r[f][k] - a[f][k]) < 0.02]).toEqual([f, k, true]);
  });

  it("puts every joint inside its limits and keeps a valid hand", () => {
    // a broken hand: index bent backwards 60 degrees, middle PIP 150 degrees, ring spread 40 degrees
    const bad = deg({ thumb: [40, 25, 30, 20], index: [0, -60, 0, 0], middle: [0, 30, 150, 10], ring: [-40, 10, 10, 10], pinky: [-10, 10, 10, 10] });
    const pts = handFrom(bad);
    expect(countViolations(pts, "right").count).toBeGreaterThanOrEqual(3);
    const s = solveHand(pts, "right", geomFromPoints(pts))!;
    for (const f of FINGERS) s.angles[f].forEach((v, k) => {
      expect(v).toBeGreaterThanOrEqual(LIMITS[f].lo[k] - 1e-9);
      expect(v).toBeLessThanOrEqual(LIMITS[f].hi[k] + 1e-9);
    });
    expect(countViolations(handFrom(s.angles), "right").count).toBe(0);
  });

  it("keeps a pointing hand pointing (index straight, others curled)", () => {
    const point = deg({ thumb: [20, 45, 40, 30], index: [0, 0, 0, 0], middle: [0, 85, 100, 60], ring: [0, 85, 100, 60], pinky: [0, 85, 100, 60] });
    const s = solveHand(handFrom(point), "right", GEOM)!;
    expect(Math.abs(s.angles.index[1]) + Math.abs(s.angles.index[2])).toBeLessThan(8 * D);
    expect(s.angles.middle[2]).toBeGreaterThan(80 * D);
  });

  it("pushes overlapping neighbour fingers apart", () => {
    const crossed = deg({ thumb: [40, 25, 30, 20], index: [-15, 0, 0, 0], middle: [15, 0, 0, 0], ring: [0, 10, 10, 5], pinky: [0, 10, 10, 5] });
    const pts = handFrom(crossed);
    expect(countOverlaps(pts, "right")).toBeGreaterThan(0);
    const s = solveHand(pts, "right", GEOM)!;
    expect(countOverlaps(handFrom(s.angles), "right")).toBe(0);
  });

  it("left hands mirror right hands", () => {
    const a = deg({ thumb: [40, 25, 30, 20], index: [10, 5, 10, 5], middle: [-5, 60, 80, 40], ring: [-8, 70, 90, 50], pinky: [-15, 80, 95, 60] });
    const mirrored = handFrom(a).map(([x, y, z]) => [-x, y, z] as V3);
    const F = palmFrame(mirrored, "left")!;
    const r = readAngles(mirrored.map((p) => toLocal(F, p)));
    for (const f of FINGERS) for (let k = 0; k < 4; k++) expect([f, k, Math.abs(r[f][k] - a[f][k]) < 0.02]).toEqual([f, k, true]);
  });

  it("one-euro smoothing removes jitter and the zero-phase pass does not lag", () => {
    const f = new OneEuro(1.7, 0.4);
    let last = 0;
    for (let i = 0; i < 50; i++) last = f.filter(i % 2 ? 0.1 : -0.1, 1 / 24);
    expect(Math.abs(last)).toBeLessThan(0.06);
    const a = deg({ thumb: [40, 25, 30, 20], index: [0, 0, 0, 0], middle: [0, 0, 0, 0], ring: [0, 0, 0, 0], pinky: [0, 0, 0, 0] });
    const b = deg({ thumb: [40, 25, 30, 20], index: [0, 80, 90, 40], middle: [0, 0, 0, 0], ring: [0, 0, 0, 0], pinky: [0, 0, 0, 0] });
    const seq = [...Array(12).fill(a), ...Array(12).fill(b)];
    const out = smoothSequence(seq, 24);
    // the step stays centred on frame 11.5: symmetric around it
    const mid = (out[11]![("index")][1] + out[12]![("index")][1]) / 2;
    expect(Math.abs(mid - 40 * D)).toBeLessThan(6 * D);
  });
});
