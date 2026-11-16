import { describe, expect, it } from "vitest";
import { DEFAULT_PLACE, baseWrist, faceDistance, keepHandContact, locDistances, sourceAnchors, sourceHand, twoBoneIK, wristTarget, type Anchors } from "../src/place";
import type { V3 } from "../src/hand";
import { makeMotion } from "./helpers";

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const plus = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** a body: shoulders 0.33 apart at y = 0, a face above (head 0.15 wide) at `headUp` */
function body(sw: number, headUp: number, headW: number, z = 0): Anchors {
  const hy = headUp, hw = headW / 2;
  return {
    shL: [sw / 2, 0, 0], shR: [-sw / 2, 0, 0],
    nose: [0, hy, z + 0.1], chin: [0, hy - 0.07, z + 0.08],
    eyeL: [0.032, hy + 0.035, z + 0.08], eyeR: [-0.032, hy + 0.035, z + 0.08],
    earL: [hw, hy + 0.01, z], earR: [-hw, hy + 0.01, z],
  };
}

describe("two-bone IK", () => {
  it("keeps the bone lengths and reaches a reachable target", () => {
    const s: V3 = [0.16, 1.27, 0], t: V3 = [0.05, 1.45, 0.25];
    const { elbow, wrist } = twoBoneIK(s, t, 0.24, 0.22, [0.3, 1.0, -0.1]);
    expect(dist(s, elbow)).toBeCloseTo(0.24, 5);
    expect(dist(elbow, wrist)).toBeCloseTo(0.22, 5);
    expect(dist(wrist, t)).toBeLessThan(1e-6);
  });
  it("puts the elbow on the pole's side", () => {
    const s: V3 = [0, 0, 0], t: V3 = [0, 0.3, 0];
    expect(twoBoneIK(s, t, 0.24, 0.22, [1, 0.1, 0]).elbow[0]).toBeGreaterThan(0.1);
    expect(twoBoneIK(s, t, 0.24, 0.22, [-1, 0.1, 0]).elbow[0]).toBeLessThan(-0.1);
  });
  it("clamps an unreachable target onto the shoulder-target line", () => {
    const { wrist } = twoBoneIK([0, 0, 0], [1, 0, 0], 0.24, 0.22, [0, -1, 0]);
    expect(wrist[0]).toBeCloseTo(0.46 * 0.9995, 4);
    expect(Math.abs(wrist[1]) + Math.abs(wrist[2])).toBeLessThan(1e-9);
  });
});

describe("hand placement", () => {
  // source: head low above the shoulders; avatar: head 8 cm higher, same shoulders
  const src = body(0.33, 0.16, 0.15, 0.0);
  const av = body(0.33, 0.24, 0.15, 0.0);

  it("a fingertip on the source's chin lands on the avatar's chin", () => {
    const tip: V3 = plus(src.chin, [0, -0.005, 0.15]); // tracker depth puts it 15 cm in front
    const wrist: V3 = plus(tip, [0.02, -0.17, 0]);
    const off: V3 = [-0.02, 0.17, 0]; // the avatar hand: tip above the wrist
    const base: V3 = plus(wrist, [0.0, 0.0, 0.0]); // the copied arm: the source wrist
    const { target } = wristTarget(base, [wrist, tip], [[0, 0, 0], off], src, av);
    const avTip = plus(target, off);
    expect(dist(avTip, plus(av.chin, [0, -0.005, 0.015]))).toBeLessThan(0.02);
  });

  it("a hand far from the face stays at the base position", () => {
    const wrist: V3 = [0.05, -0.35, 0.25]; // chest height, fingers up
    const tip: V3 = plus(wrist, [0, 0.17, 0]);
    const base: V3 = [0.06, -0.34, 0.24];
    const { target, pull } = wristTarget(base, [wrist, tip], [[0, 0, 0], [0, 0.17, 0]], src, av);
    expect(pull).toBeLessThan(0.05);
    expect(dist(target, base)).toBeLessThan(0.005);
  });

  it("base wrist keeps the frontal position (in shoulder widths) and the arm's reach", () => {
    const wide = body(0.40, 0.2, 0.15);
    const sh: V3 = wide.shL;
    const w = baseWrist([0.1, -0.1, 0.3], src, wide, sh, 0.35, true);
    expect(w[0]).toBeCloseTo(0.1 * (0.40 / 0.33), 6);
    expect(w[1]).toBeCloseTo(-0.1 * (0.40 / 0.33), 6);
    expect(dist(w, sh)).toBeCloseTo(0.35, 6);
    expect(w[2]).toBeGreaterThan(sh[2]);
  });

  it("two touching source hands touch on the avatar", () => {
    const pL: V3 = [0.01, -0.1, 0.3], pR: V3 = [-0.01, -0.1, 0.3];
    const tL: V3 = [0.1, -0.1, 0.3], tR: V3 = [-0.12, -0.1, 0.3]; // the avatar's wrists ended up apart
    const c = keepHandContact([pL], [pR], [[0, 0, 0]], [[0, 0, 0]], tL, tR, src, src, DEFAULT_PLACE);
    expect(c).toBe(1);
    expect(dist(tL, tR)).toBeCloseTo(0.02, 6);
  });
});

describe("location metric", () => {
  it("measures frontal distances in shoulder widths and face contacts", () => {
    const a = body(0.3, 0.16, 0.15);
    const hand = Array.from({ length: 21 }, () => [0, -1, 0] as V3);
    hand[0] = [0, -0.14, 0.5]; // wrist: 0.3 below the nose, depth ignored
    hand[8] = [a.chin[0], a.chin[1], 0.4];
    const d = locDistances(a, hand);
    expect(d[0]).toBeCloseTo(0.3 / 0.3, 6); // wrist-nose
    expect(d[5]).toBeCloseTo(0, 6); // index-chin
    expect(faceDistance(a, hand)).toBeCloseTo(0, 6);
    expect(faceDistance(a, hand, 3)).toBeGreaterThan(1);
  });

  it("reads source anchors and hands from a motion frame", () => {
    const m = makeMotion(3, () => 0.5, { width: 1000, height: 1000 });
    const f = m.frames[0];
    // shoulders 300 px apart in the image and 0.3 m in the world, ears 150 px / 0.15 m: 1 mm per pixel
    f.pose![11] = [0.65, 0.5, 0, 1]; f.pose![12] = [0.35, 0.5, 0, 1];
    f.pose![7] = [0.575, 0.3, 0, 1]; f.pose![8] = [0.425, 0.3, 0, 1];
    f.poseWorld![11] = [0.15, 0, 0]; f.poseWorld![12] = [-0.15, 0, 0];
    f.poseWorld![7] = [0.075, -0.2, 0]; f.poseWorld![8] = [-0.075, -0.2, 0];
    for (const g of m.frames.slice(1)) { g.pose = f.pose; g.poseWorld = f.poseWorld; }
    const a = sourceAnchors(f, m)!;
    expect(Math.hypot(a.shL[0] - a.shR[0], a.shL[1] - a.shR[1])).toBeCloseTo(0.3, 6);
    expect(a.shL[0]).toBeGreaterThan(a.shR[0]); // subject left = +x
    const h = sourceHand(f, m, "left")!;
    expect(h).toHaveLength(21);
    expect(h[0][1]).toBeCloseTo(-0.5, 6); // image y down -> y up
  });
});

describe("head push-out", () => {
  it("moves a hand inside the face forward onto it, and leaves a hand beside the head alone", async () => {
    const { headEllipsoid, headPushOut } = await import("../src/place");
    const av = body(0.33, 0.24, 0.15);
    const head = headEllipsoid(av);
    const inside: V3 = [0, av.nose[1], av.earL[2] + 0.02];
    const dz = headPushOut(inside, [[0, 0, 0]], head);
    expect(dz).toBeGreaterThan(0.03);
    expect(headPushOut([0, av.nose[1], av.earL[2] + 0.02 + dz + 1e-6], [[0, 0, 0]], head)).toBeLessThan(1e-6);
    expect(headPushOut([0.3, av.nose[1], 0], [[0, 0, 0]], head)).toBe(0);
  });
});

describe("elbow swivel and face occlusion", () => {
  // camera 3 m in front, looking down -z
  const proj = (p: V3): V3 => { const d = 3 - p[2]; return [p[0] / d, p[1] / d, d]; };

  it("counts face points covered by an arm in front of the face, not one beside it", async () => {
    const { faceOcclusion, faceSamples } = await import("../src/place");
    const av = body(0.33, 0.24, 0.15);
    const face = faceSamples(av);
    const across = [{ a: [-0.25, 0.2, 0.25] as V3, b: [0.05, av.nose[1], 0.25] as V3, r: 0.04 }];
    const beside = [{ a: [-0.3, 0.0, 0.0] as V3, b: [-0.25, 0.3, 0.0] as V3, r: 0.04 }];
    expect(faceOcclusion(face, across, proj).count).toBeGreaterThan(1);
    expect(faceOcclusion(face, beside, proj).count).toBe(0);
  });

  it("moves the elbow out of the way when the tracked swivel puts the forearm across the face", async () => {
    const { elbowCost, faceOcclusion, faceSamples, swivelIK } = await import("../src/place");
    const av = body(0.33, 0.24, 0.15);
    const face = faceSamples(av);
    const s = av.shR, t: V3 = [av.eyeR[0], av.eyeR[1], av.eyeR[2] + 0.03];
    const segs = (e: V3) => [{ a: s, b: e, r: 0.045 }, { a: e, b: [e[0] + (t[0] - e[0]) * 0.8, e[1] + (t[1] - e[1]) * 0.8, e[2] + (t[2] - e[2]) * 0.8] as V3, r: 0.038 }];
    const cost = elbowCost(face, proj, s, t, 0.24, [-1, 0, 0]);
    // pole up and across in front: the plain IK forearm would come in over the face
    const pole: V3 = [0.15, 0.35, 0.35];
    const r = swivelIK(s, t, 0.24, 0.22, pole, cost, null);
    expect(dist(s, r.elbow)).toBeCloseTo(0.24, 5);
    expect(dist(r.elbow, r.wrist)).toBeCloseTo(0.22, 5);
    const plain = twoBoneIK(s, t, 0.24, 0.22, pole);
    const { visibleFace } = await import("../src/place");
    const vis = visibleFace(face, [t]); // the eye and cheek the hand is at are the hand's
    const before = faceOcclusion(vis, segs(plain.elbow), proj), after = faceOcclusion(vis, segs(r.elbow), proj);
    expect(before.count).toBeGreaterThanOrEqual(2);
    expect(after.count).toBe(0);
    expect(r.elbow[2]).toBeGreaterThan(s[2] - 0.01); // not behind the shoulder
    expect(r.elbow[0]).toBeLessThan(av.earR[0]); // the elbow is out beside the face, not under it
    // with nothing in the way the tracked swivel is kept
    const free = swivelIK(s, t, 0.24, 0.22, pole, () => 0, null);
    expect(dist(free.elbow, plain.elbow)).toBeLessThan(1e-3);
  });
});
