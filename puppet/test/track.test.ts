import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  alignHemispheres, angleDeg4, cleanQuatChannel, cleanScalarChannel, DEFAULT_CLEAN, fillQuatGaps, findSpikes, framePos,
  linkedSpikes, removeSpikes, smoothQuats, twistAbout, type QuatChannel,
} from "../src/track";

const FPS = 24;
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

/** n frames of a rotation about `axis`, angle (degrees) per frame from `deg(i)` */
function track(n: number, deg: (i: number) => number, axis = Z): Float32Array {
  const q = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) new THREE.Quaternion().setFromAxisAngle(axis, (deg(i) * Math.PI) / 180).toArray(q as unknown as number[], 4 * i);
  return q;
}
/** signed angle (degrees) about `axis` of frame i */
function angleAt(q: Float32Array, i: number, axis = Z): number {
  const r = new THREE.Quaternion().fromArray(q as unknown as number[], 4 * i);
  const s = r.x * axis.x + r.y * axis.y + r.z * axis.z;
  return (2 * Math.atan2(s, r.w) * 180) / Math.PI;
}
const allValid = (n: number) => new Uint8Array(n).fill(1);
const chan = (q: Float32Array, valid: Uint8Array, maxSpeedDegS = 1000, sigmaS = 0): QuatChannel => ({ name: "t", q, valid, params: { maxSpeedDegS, sigmaS } });
const findSpikesOf = (c: QuatChannel, n: number) => findSpikes(c.q, c.valid, n, FPS, c.params.maxSpeedDegS);

describe("removeSpikes", () => {
  it("replaces a one-frame flip (a hand read inside out) with the path between its neighbours", () => {
    const q = track(20, (i) => (i === 10 ? 170 : i * 2));
    const n = removeSpikes(q, allValid(20), 20, FPS, 1000);
    expect(n).toBe(1);
    expect(angleAt(q, 10)).toBeCloseTo(20, 3);
    expect(angleAt(q, 9)).toBeCloseTo(18, 3); // neighbours untouched
  });

  it("replaces a two- and a three-frame flip", () => {
    const q2 = track(30, (i) => (i === 10 || i === 11 ? 160 : 0));
    expect(removeSpikes(q2, allValid(30), 30, FPS, 1000)).toBeGreaterThanOrEqual(2);
    for (const i of [10, 11]) expect(Math.abs(angleAt(q2, i))).toBeLessThan(0.01);
    const q3 = track(30, (i) => (i >= 10 && i <= 12 ? -150 : 5));
    removeSpikes(q3, allValid(30), 30, FPS, 1000);
    for (const i of [10, 11, 12]) expect(angleAt(q3, i)).toBeCloseTo(5, 2);
  });

  it("keeps real motion: a fast sweep, a held step change and a slower out-and-back", () => {
    const sweep = track(40, (i) => i * 30); // 720 deg/s, under the 1000 deg/s limit
    const before = sweep.slice();
    expect(removeSpikes(sweep, allValid(40), 40, FPS, 1000)).toBe(0);
    expect(Array.from(sweep)).toEqual(Array.from(before));
    const step = track(20, (i) => (i < 10 ? 0 : 80)); // a step that stays is not a glitch
    removeSpikes(step, allValid(20), 20, FPS, 1000);
    for (let i = 10; i < 20; i++) expect(angleAt(step, i)).toBeCloseTo(80, 3);
    const outBack = track(20, (i) => (i === 10 ? 40 : 0)); // 40 deg out and back in 2 frames: possible at 1000 deg/s
    expect(removeSpikes(outBack, allValid(20), 20, FPS, 1000)).toBe(0);
  });

  it("only uses tracked frames as anchors and never touches untracked ones", () => {
    const q = track(10, (i) => (i === 5 ? 170 : 0));
    const valid = allValid(10);
    valid[4] = 0; // the spike's left neighbour was not tracked: no safe anchor
    expect(removeSpikes(q, valid, 10, FPS, 1000)).toBe(0);
    expect(angleAt(q, 5)).toBeCloseTo(170, 3);
  });
});

describe("fillQuatGaps", () => {
  it("bridges a short gap with the path between the tracked poses", () => {
    const q = track(20, (i) => (i < 8 ? 0 : i > 11 ? 40 : 999)); // 999 = rest fallback stored at the gap
    const valid = allValid(20);
    for (let i = 8; i <= 11; i++) valid[i] = 0;
    const s = fillQuatGaps(q, valid, 20, FPS);
    expect(s.bridgedFrames).toBe(4);
    for (let i = 8; i <= 11; i++) expect(angleAt(q, i)).toBeCloseTo((40 * (i - 7)) / 5, 3);
  });

  it("eases a long gap from the last pose to the fallback and back in before the next pose (no snap)", () => {
    const n = 60;
    const q = track(n, (i) => (i < 10 || i >= 50 ? 90 : 0)); // fallback (rest) = 0 inside the gap
    const valid = allValid(n);
    for (let i = 10; i < 50; i++) valid[i] = 0;
    fillQuatGaps(q, valid, n, FPS);
    const a = Array.from({ length: n }, (_, i) => angleAt(q, i));
    // continuous: no frame-to-frame jump bigger than a fade step
    for (let i = 1; i < n; i++) expect(Math.abs(a[i] - a[i - 1])).toBeLessThan(30);
    expect(a[10]).toBeGreaterThan(80); // just after the loss: still close to the last pose
    expect(a[30]).toBeCloseTo(0, 3); // middle of the gap: fallback
    expect(a[49]).toBeGreaterThan(80); // just before tracking returns: already close to the next pose
    // monotone ease out and back in
    for (let i = 10; i < 17; i++) expect(a[i + 1]).toBeLessThanOrEqual(a[i] + 1e-6);
    for (let i = 43; i < 49; i++) expect(a[i + 1]).toBeGreaterThanOrEqual(a[i] - 1e-6);
  });

  it("eases in from the fallback at the start of a clip", () => {
    const q = track(30, (i) => (i < 12 ? 0 : 60));
    const valid = allValid(30);
    for (let i = 0; i < 12; i++) valid[i] = 0;
    fillQuatGaps(q, valid, 30, FPS);
    expect(angleAt(q, 0)).toBeCloseTo(0, 3);
    expect(angleAt(q, 11)).toBeGreaterThan(50);
    for (let i = 0; i < 11; i++) expect(angleAt(q, i + 1)).toBeGreaterThanOrEqual(angleAt(q, i) - 1e-6);
  });
});

describe("smoothQuats", () => {
  it("is zero-phase: keeps a constant rotation, a constant-speed turn and a held pose exactly", () => {
    const c = track(20, () => 33);
    smoothQuats(c, 20, FPS, 0.04);
    for (let i = 0; i < 20; i++) expect(angleAt(c, i)).toBeCloseTo(33, 3);
    const ramp = track(30, (i) => i * 3);
    smoothQuats(ramp, 30, FPS, 0.025);
    for (let i = 3; i < 27; i++) expect(angleAt(ramp, i)).toBeCloseTo(i * 3, 2); // no lag
    const held = track(30, (i) => (i < 15 ? 0 : 60));
    smoothQuats(held, 30, FPS, 0.025);
    for (const i of [0, 5, 11, 18, 24, 29]) expect(angleAt(held, i)).toBeCloseTo(i < 15 ? 0 : 60, 2);
  });

  it("cuts frame-to-frame jitter", () => {
    const jit = track(40, (i) => 20 + (i % 2 ? 4 : -4));
    smoothQuats(jit, 40, FPS, 0.025);
    for (let i = 3; i < 37; i++) expect(Math.abs(angleAt(jit, i) - 20)).toBeLessThan(4 * 0.4);
  });

  it("does not care about the quaternion sign (q and -q are the same rotation)", () => {
    const q = track(20, () => 45);
    const ref = track(1, () => 45);
    for (let i = 0; i < 20; i += 2) for (let d = 0; d < 4; d++) q[4 * i + d] *= -1;
    smoothQuats(q, 20, FPS, 0.04);
    for (let i = 0; i < 20; i++) expect(angleDeg4(q, i, 0, ref)).toBeLessThan(0.1); // float32 storage
  });

  it("does not pull the first and last frames (symmetric window at the clip edges)", () => {
    const ramp = track(12, (i) => 10 + i * 8);
    smoothQuats(ramp, 12, FPS, 0.04);
    for (let i = 0; i < 12; i++) expect(angleAt(ramp, i)).toBeCloseTo(10 + i * 8, 2);
  });
});

describe("cleanQuatChannel", () => {
  it("removes a glitch inside a dropout-free stretch and leaves the rest of a real sign alone", () => {
    const n = 48;
    const real = (i: number) => 60 * Math.sin((2 * Math.PI * i) / 24); // 1 Hz, 60 deg: a normal signing movement
    const q = track(n, (i) => (i === 20 ? real(i) + 170 : real(i)));
    const s = cleanQuatChannel(chan(q, allValid(n), 1000, 0.025), n, FPS);
    expect(s.spikeFrames).toBe(1);
    for (let i = 0; i < n; i++) expect(Math.abs(angleAt(q, i) - real(i))).toBeLessThan(i === 20 ? 2 : 1);
  });

  it("returns what it changed", () => {
    const n = 40;
    const q = track(n, (i) => (i === 5 ? 170 : 0));
    const valid = allValid(n);
    for (let i = 20; i < 23; i++) valid[i] = 0;
    for (let i = 30; i < 40; i++) valid[i] = 0;
    const s = cleanQuatChannel(chan(q, valid), n, FPS, DEFAULT_CLEAN);
    expect(s).toEqual({ spikeFrames: 1, bridgedFrames: 3, fadedFrames: 6 });
  });
});

describe("linkedSpikes", () => {
  const n = 20;
  const glitchy = (i: number, deg: number) => (i >= 8 && i <= 10 ? deg : 0);

  it("repairs the whole chain when many bones glitch together (a hand read inside out)", () => {
    // the wrist turns a little too far for 3 frames (below its own glitch test), 5 fingers compensate hard
    const wrist = chan(track(n, (i) => glitchy(i, 45)), allValid(n), 1000);
    const fingers = Array.from({ length: 5 }, () => chan(track(n, (i) => glitchy(i, -140)), allValid(n), 1500));
    expect(Array.from(findSpikesOf(wrist, n))).not.toContain(1);
    const masks = linkedSpikes([wrist, ...fingers], n, FPS, { parents: 1, minVotes: 5 });
    expect(Array.from(masks[0].slice(8, 11))).toEqual([1, 1, 1]);
    [wrist, ...fingers].forEach((c, k) => cleanQuatChannel(c, n, FPS, DEFAULT_CLEAN, masks[k]));
    for (let i = 8; i <= 10; i++) for (const c of [wrist, ...fingers]) expect(Math.abs(angleAt(c.q, i))).toBeLessThan(0.01);
  });

  it("repairs the whole chain when a parent glitches", () => {
    const wrist = chan(track(n, (i) => glitchy(i, 170)), allValid(n), 1000);
    const finger = chan(track(n, (i) => glitchy(i, 20)), allValid(n), 1500); // fine on its own
    const masks = linkedSpikes([wrist, finger], n, FPS, { parents: 1, minVotes: 5 });
    expect(Array.from(masks[1].slice(8, 11))).toEqual([1, 1, 1]);
  });

  it("repairs a single bad finger alone, leaving its parent and the other fingers as tracked", () => {
    const wrist = chan(track(n, (i) => i * 2), allValid(n), 1000);
    const bad = chan(track(n, (i) => glitchy(i, -140)), allValid(n), 1500);
    const good = chan(track(n, (i) => i * 3), allValid(n), 1500);
    const masks = linkedSpikes([wrist, bad, good], n, FPS, { parents: 1, minVotes: 5 });
    expect(Array.from(masks[1].slice(8, 11))).toEqual([1, 1, 1]);
    expect(Array.from(masks[0])).not.toContain(1);
    expect(Array.from(masks[2])).not.toContain(1);
  });
});

describe("cleanScalarChannel", () => {
  it("bridges short gaps linearly and keeps blinks (fast on purpose)", () => {
    const v = new Float32Array([0, 0, 1, 0, 0, 0.4, 0, 0, 0.8, 0]);
    const valid = new Uint8Array([1, 1, 1, 1, 1, 1, 0, 0, 1, 1]);
    cleanScalarChannel({ name: "blink", v, valid }, 10, FPS);
    expect(v[2]).toBe(1); // a one-frame blink stays
    expect(v[6]).toBeCloseTo(0.4 + (0.8 - 0.4) / 3, 5);
    expect(v[7]).toBeCloseTo(0.4 + (2 * (0.8 - 0.4)) / 3, 5);
  });
});

describe("helpers", () => {
  it("framePos clamps and splits a fractional frame", () => {
    expect(framePos(10, -1)).toEqual({ k: 0, w: 0 });
    expect(framePos(10, 3.25)).toEqual({ k: 3, w: 0.25 });
    expect(framePos(10, 9.5)).toEqual({ k: 9, w: 0 });
    expect(framePos(10, NaN)).toEqual({ k: 0, w: 0 });
  });

  it("twistAbout returns the roll about the axis, and swing * twist rebuilds the rotation", () => {
    const roll = new THREE.Quaternion().setFromAxisAngle(X, 1.1);
    const swing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0.6, 0.8), 0.7);
    const q = swing.clone().multiply(roll);
    const t = twistAbout(q, X);
    expect(2 * Math.acos(Math.abs(t.w))).toBeCloseTo(1.1, 6);
    const rebuilt = q.clone().multiply(t.clone().invert()).multiply(t);
    expect(rebuilt.angleTo(q)).toBeLessThan(1e-6);
    // the swing left over has no roll about the axis
    const left = twistAbout(q.clone().multiply(t.clone().invert()), X);
    expect(2 * Math.acos(Math.min(1, Math.abs(left.w)))).toBeLessThan(1e-6);
  });

  it("alignHemispheres and angleDeg4 agree on q vs -q", () => {
    const q = track(3, (i) => i * 10);
    for (let d = 0; d < 4; d++) q[4 + d] *= -1;
    expect(angleDeg4(q, 0, 1)).toBeCloseTo(10, 4);
    alignHemispheres(q, 3);
    expect(q[7]).toBeGreaterThan(0);
  });
});
