// Hand LOCATION: where the hands are relative to the face and body, measured and retargeted.
//
// Copying arm rotations puts the avatar's hands where the source's would be on the avatar's arms, which is not the
// same place relative to its face: the realistic signer's head sits higher above its shoulders than the source's,
// so a finger on the source's eye ends up beside the avatar's temple. In ASL the location is part of the sign, so
// the hands are placed by position instead:
//
//  1. Source points go into a "location space" (three.js axes, metres): x and y from the IMAGE landmarks (exact
//     in the picture) scaled to metres, z from poseWorld. The tracker's depth is the weak part: a hand touching the
//     face comes out ~15 cm in front of it in poseWorld, so near the face depth is taken from the face, not the
//     tracker (see FACE_DEPTH_KEEP).
//  2. Every hand point is mapped onto the avatar relative to its own landmarks: near the face relative to the
//     nearest face points (nose, chin, eyes, ears), scaled by head width; elsewhere relative to the shoulders,
//     scaled by shoulder width (the base). Inverse-distance weights blend the two smoothly, so a fingertip on the
//     chin lands on the avatar's chin and a hand in neutral space keeps its place in front of the chest.
//  3. src/vrm.ts turns the wanted wrist position into upper-arm and forearm rotations with two-bone IK; the elbow
//     stays on the side the tracked elbow was on (swivel), and the hand keeps its tracked orientation.
//
// The same anchors give the location metric of the render report (locDistances / faceDistance).
// No three.js here: plain arrays, so it runs in tests.

import type { Motion, MotionFrame } from "./motion";
import type { Side, V3 } from "./hand";

export const FACE_KEYS = ["nose", "chin", "eyeL", "eyeR", "earL", "earR"] as const;
export type FaceKey = (typeof FACE_KEYS)[number];
/** body landmarks in three.js axes (y up, +z toward the camera), metres. L/R = the subject's / avatar's own side. */
export type Anchors = Record<FaceKey | "shL" | "shR", V3>;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const len2 = (a: V3) => Math.hypot(a[0], a[1]);
const mid = (a: V3, b: V3): V3 => mul(add(a, b), 0.5);

export const shoulderWidth = (a: Anchors) => len(sub(a.shL, a.shR));
export const headWidth = (a: Anchors) => len(sub(a.earL, a.earR));
export const sternum = (a: Anchors): V3 => mid(a.shL, a.shR);

// ---------------------------------------------------------------- source location space
/** metres per image pixel for one frame: shoulder + ear distance in poseWorld over the same in the image (2D) */
export function frameScale(f: MotionFrame, m: Motion): number | null {
  const P = f.poseWorld, I = f.pose;
  if (!P || !I) return null;
  const px = (k: number): V3 => [I[k][0] * m.width, I[k][1] * m.height, 0];
  const w = len(sub(P[11] as V3, P[12] as V3)) + len(sub(P[7] as V3, P[8] as V3));
  const i = len2(sub(px(11), px(12))) + len2(sub(px(7), px(8)));
  return i > 1 ? w / i : null;
}

const median = (v: number[]) => { const s = v.filter((x) => isFinite(x)).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const scaleCache = new WeakMap<Motion, (number | null)[]>();
/** a sentence joined from several source videos (src/blend.ts): each part has its own camera */
const isComposed = (m: Motion) => m.source?.dataset === "blend" || Array.isArray((m.cleanup as { clips?: unknown } | null)?.clips);

/**
 * Metres per pixel at frame i. One clip: the median over the clip (the camera does not move, the per-frame value
 * is noisy). A composed sentence: the median over +-0.5 s around the frame, since every part had its own camera.
 */
export function scaleAt(m: Motion, i: number): number | null {
  let arr = scaleCache.get(m);
  if (!arr) {
    const per = m.frames.map((f) => frameScale(f, m));
    if (isComposed(m)) {
      const r = Math.max(1, Math.round(m.fps / 2));
      arr = per.map((_, k) => median(per.slice(Math.max(0, k - r), k + r + 1).filter((x): x is number => x !== null)));
    } else { const c = median(per.filter((x): x is number => x !== null)); arr = per.map(() => c); }
    scaleCache.set(m, arr);
  }
  return arr[Math.max(0, Math.min(arr.length - 1, i))] ?? null;
}

/** the clip's metres per pixel (median over frames) */
export function clipScale(m: Motion): number | null {
  return median(m.frames.map((f) => frameScale(f, m)).filter((x): x is number => x !== null));
}

const frameIndex = (f: MotionFrame, m: Motion) => (m.frames[f.i] === f ? f.i : Math.max(0, m.frames.indexOf(f)));

/**
 * Source landmarks in location space: x, y from the image (pixels times the clip scale, y up), z from poseWorld
 * (toward the camera). Face points from the face mesh (nose tip 1, chin 152, eye corners, the face outline at the
 * ears 234 / 454), placed in depth at the poseWorld nose; without a face mesh, from the pose's face points.
 */
export function sourceAnchors(f: MotionFrame, m: Motion): Anchors | null {
  const P = f.poseWorld, I = f.pose;
  const s = scaleAt(m, frameIndex(f, m)) ?? frameScale(f, m);
  if (!P || !I || !s) return null;
  const pose = (k: number): V3 => [I[k][0] * m.width * s, -I[k][1] * m.height * s, -P[k][2]];
  const a: Partial<Anchors> = { shL: pose(11), shR: pose(12) };
  const F = f.face;
  if (F && F.length >= 468) {
    const z0 = -P[0][2], fz1 = F[1][2];
    const fp = (k: number): V3 => [F[k][0] * m.width * s, -F[k][1] * m.height * s, z0 - (F[k][2] - fz1) * m.width * s];
    a.nose = fp(1);
    a.chin = fp(152);
    a.eyeL = mid(fp(263), fp(362)); // the subject's left eye (image right)
    a.eyeR = mid(fp(33), fp(133));
    const e1 = fp(454), e2 = fp(234);
    const near = len(sub(e1, a.eyeL)) < len(sub(e2, a.eyeL));
    a.earL = near ? e1 : e2;
    a.earR = near ? e2 : e1;
  } else {
    a.nose = pose(0);
    a.eyeL = pose(2); a.eyeR = pose(5);
    a.earL = pose(7); a.earR = pose(8);
    const mouth = mid(pose(9), pose(10));
    a.chin = add(mouth, mul(sub(mouth, a.nose), 1.1));
  }
  return a as Anchors;
}

/**
 * The 21 points of one source hand in location space, or null when the hand is not tracked. x, y from the image
 * hand landmarks; z = poseWorld wrist depth plus the hand's own shape (world hand, v2 hands3d, or image z).
 */
export function sourceHand(f: MotionFrame, m: Motion, side: Side): V3[] | null {
  const P = f.poseWorld;
  const s = scaleAt(m, frameIndex(f, m)) ?? frameScale(f, m);
  const img = side === "left" ? f.leftHand : f.rightHand;
  if (!P || !s || !img) return null;
  const wz = -P[side === "left" ? 15 : 16][2];
  const hw = side === "left" ? f.leftHandWorld : f.rightHandWorld;
  const h3 = f.hands3d?.[side]?.joints;
  const dz = (k: number) => (hw ? hw[k][2] - hw[0][2] : h3?.length === 21 ? h3[k][2] - h3[0][2] : (img[k][2] - img[0][2]) * m.width * s);
  return img.map((p, k) => [p[0] * m.width * s, -p[1] * m.height * s, wz - dz(k)] as V3);
}

/** the wrist alone (pose landmark), for a tracked arm whose hand was not found */
export function sourceWrist(f: MotionFrame, m: Motion, side: Side): V3 | null {
  const P = f.poseWorld, I = f.pose;
  const s = scaleAt(m, frameIndex(f, m)) ?? frameScale(f, m);
  if (!P || !I || !s) return null;
  const k = side === "left" ? 15 : 16;
  return [I[k][0] * m.width * s, -I[k][1] * m.height * s, -P[k][2]];
}

// ---------------------------------------------------------------- metric
/** (hand point, anchor) pairs of the location metric */
export const LOC_PAIRS: { name: string; hand: number; anchor: FaceKey | "shL" | "shR" }[] = [];
for (const [hn, h] of [["wrist", 0], ["index", 8]] as const)
  for (const a of ["nose", "chin", "shL", "shR"] as const) LOC_PAIRS.push({ name: `${hn}-${a}`, hand: h, anchor: a });
/** hand points that can make contact (wrist and the five fingertips) */
export const CONTACT_POINTS = [0, 4, 8, 12, 16, 20];
/** a hand point closer than this to a face point (frontal plane, in shoulder widths) is a contact */
export const CONTACT_DIST = 0.15;

/**
 * Frontal-plane (x, y) distances of the LOC_PAIRS, in shoulder widths. Frontal because the tracker's depth is
 * not reliable enough to compare (see the top of the file), and the frontal view is what a viewer reads.
 */
export function locDistances(a: Anchors, hand: V3[]): number[] {
  const sw = shoulderWidth(a);
  return LOC_PAIRS.map((p) => len2(sub(hand[p.hand], a[p.anchor])) / sw);
}

/** nearest contact point to any face point, in shoulder widths: frontal plane (dims 2) or 3D (dims 3) */
export function faceDistance(a: Anchors, hand: V3[], dims: 2 | 3 = 2): number {
  const sw = shoulderWidth(a);
  let best = Infinity;
  for (const k of CONTACT_POINTS) for (const f of FACE_KEYS) best = Math.min(best, (dims === 2 ? len2 : len)(sub(hand[k], a[f])));
  return best / sw;
}

// ---------------------------------------------------------------- placement
export interface PlaceParams {
  /** falloff of a face point's pull, in source head widths: at this distance it weighs as much as the base */
  faceSigma: number;
  /** how much of the tracker's depth offset from a face point is kept (0 = put the hand at the face's depth) */
  faceDepthKeep: number;
  /** how much the tracker's depth counts when measuring closeness to the face (frontal distance matters most) */
  faceDepthWeight: number;
  /** two hands closer than `hhNear` shoulder widths keep their exact offset; beyond `hhFar` they are independent */
  hhNear: number;
  hhFar: number;
}
export const FACE_DEPTH_KEEP = 0.1;
export const DEFAULT_PLACE: PlaceParams = { faceSigma: 0.45, faceDepthKeep: FACE_DEPTH_KEEP, faceDepthWeight: 0.25, hhNear: 0.1, hhFar: 0.3 };

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Base wrist position on the avatar: the source wrist's frontal offset from the sternum, scaled by shoulder width,
 * at the depth that keeps the shoulder-wrist distance of the tracked arm (`reach`, from the copied elbow angle),
 * on the side (front/back of the shoulder) the copied arm was on.
 */
export function baseWrist(srcWrist: V3, src: Anchors, av: Anchors, avShoulder: V3, reach: number, front: boolean): V3 {
  const k = shoulderWidth(av) / shoulderWidth(src);
  const s0 = sternum(src), a0 = sternum(av);
  const x = a0[0] + (srcWrist[0] - s0[0]) * k, y = a0[1] + (srcWrist[1] - s0[1]) * k;
  const dxy2 = (x - avShoulder[0]) ** 2 + (y - avShoulder[1]) ** 2;
  const dz = Math.sqrt(Math.max(0, reach * reach - dxy2));
  return [x, y, avShoulder[2] + (front ? dz : -dz)];
}

/**
 * Wanted wrist position from the base and the face anchors. `pts[e]` are source hand points (location space),
 * `offs[e]` the avatar's same points relative to its wrist, as the hand is oriented now. Each point near a face
 * point pulls the wrist so that it lands at the same place relative to the avatar's face (offset scaled by head
 * width, depth mostly the face's); the base keeps weight 1. Returns the target and the total pull (0 = base only).
 */
export function wristTarget(base: V3, pts: V3[], offs: V3[], src: Anchors, av: Anchors, p: PlaceParams = DEFAULT_PLACE): { target: V3; pull: number } {
  const kf = headWidth(av) / headWidth(src);
  const sigma = p.faceSigma * headWidth(src);
  let acc: V3 = [base[0], base[1], base[2]], wsum = 1;
  for (let e = 0; e < pts.length; e++) {
    for (const f of FACE_KEYS) {
      const d = sub(pts[e], src[f]);
      const dist = Math.hypot(d[0], d[1], d[2] * p.faceDepthWeight);
      const w = Math.min(1e4, (sigma / Math.max(dist, 1e-4)) ** 4);
      if (w < 1e-4) continue;
      const mapped: V3 = [av[f][0] + d[0] * kf, av[f][1] + d[1] * kf, av[f][2] + d[2] * kf * p.faceDepthKeep];
      acc = add(acc, mul(sub(mapped, offs[e]), w));
      wsum += w;
    }
  }
  return { target: mul(acc, 1 / wsum), pull: wsum - 1 };
}

/**
 * Hand-to-hand contact: when the two source hands are close, move both avatar wrists (half each) so the closest
 * pair of hand points has the source's offset, scaled by shoulder width. `cur*` = the avatar's points of each hand
 * relative to its own wrist; `tL`/`tR` the wrist targets (changed in place). Returns the weight used (0..1).
 */
export function keepHandContact(srcL: V3[], srcR: V3[], offL: V3[], offR: V3[], tL: V3, tR: V3, src: Anchors, av: Anchors, p: PlaceParams = DEFAULT_PLACE): number {
  const sw = shoulderWidth(src), k = shoulderWidth(av) / sw;
  let best = Infinity, bi = 0, bj = 0;
  for (let i = 0; i < srcL.length; i++) for (let j = 0; j < srcR.length; j++) {
    const d = len(sub(srcR[j], srcL[i]));
    if (d < best) { best = d; bi = i; bj = j; }
  }
  const c = 1 - smoothstep(p.hhNear, p.hhFar, best / sw);
  if (c <= 0) return 0;
  const want = mul(sub(srcR[bj], srcL[bi]), k);
  const have = sub(add(tR, offR[bj]), add(tL, offL[bi]));
  const delta = mul(sub(want, have), c * 0.5);
  for (let d = 0; d < 3; d++) { tL[d] -= delta[d]; tR[d] += delta[d]; }
  return c;
}

/**
 * Two-bone IK: elbow position for shoulder `s`, wanted wrist `t`, bone lengths l1 (upper arm), l2 (forearm).
 * The elbow goes on the side of `pole` (the tracked elbow), so the arm's swivel is kept. A target out of reach
 * (or too close) is moved along the shoulder-target line; the reachable wrist is returned with the elbow.
 */
export function twoBoneIK(s: V3, t: V3, l1: number, l2: number, pole: V3): { elbow: V3; wrist: V3 } {
  let d = sub(t, s);
  let dist = len(d);
  const u: V3 = dist > 1e-9 ? mul(d, 1 / dist) : [0, -1, 0];
  const lo = Math.abs(l1 - l2) + 1e-4, hi = (l1 + l2) * 0.9995;
  dist = Math.min(hi, Math.max(lo, dist));
  const wrist = add(s, mul(u, dist));
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // bend direction: the pole's component perpendicular to the shoulder-wrist line
  let v = sub(pole, s);
  v = sub(v, mul(u, v[0] * u[0] + v[1] * u[1] + v[2] * u[2]));
  if (len(v) < 1e-6) { // pole on the line: elbow down and back
    v = sub([0, -1, -0.3], mul(u, -u[1] - 0.3 * u[2]));
    if (len(v) < 1e-6) v = [0, 0, -1];
  }
  v = mul(v, 1 / len(v));
  d = add(add(s, mul(u, a)), mul(v, h));
  return { elbow: d, wrist };
}

/**
 * The avatar's head as an ellipsoid: centred between the ears, half the ear distance wide, from the chin to the
 * crown tall (the crown mirrored from the chin about the ear line), reaching a little short of the nose tip in front.
 */
export function headEllipsoid(av: Anchors): { c: V3; r: V3 } {
  const c = mid(av.earL, av.earR);
  return { c, r: [headWidth(av) / 2, Math.max(1e-3, (c[1] - av.chin[1]) * 1.15), Math.max(1e-3, (av.nose[2] - c[2]) * 0.85)] };
}

/**
 * How far (metres, along +z, toward the camera) the wrist must move so that no hand point (`offs`, relative to the
 * wrist at `target`) is inside the front half of the head ellipsoid. A hand placed on the face then rests on it
 * instead of in it.
 */
export function headPushOut(target: V3, offs: V3[], head: { c: V3; r: V3 }): number {
  let need = 0;
  for (const o of offs) {
    const p = add(target, o);
    const u = (p[0] - head.c[0]) / head.r[0], v = (p[1] - head.c[1]) / head.r[1];
    const q = 1 - u * u - v * v;
    if (q <= 0) continue;
    const zSurf = head.c[2] + head.r[2] * Math.sqrt(q);
    // only the front half: a hand behind the head (rare in signing) is left where it is
    if (p[2] < zSurf && p[2] >= head.c[2]) need = Math.max(need, zSurf - p[2]);
  }
  return need;
}

// ---------------------------------------------------------------- face occlusion and elbow swivel
/**
 * Points that must stay visible on the avatar's face: eyes, nose, mouth, chin, forehead and both cheeks.
 * A hand touching the face may cover some; an ARM crossing in front of them is what a real signer avoids.
 */
export function faceSamples(av: Anchors): V3[] {
  const eyes = mid(av.eyeL, av.eyeR);
  const mouth = add(mul(av.nose, 0.55), mul(av.chin, 0.45));
  const up = sub(eyes, av.chin);
  const forehead = add(eyes, mul(up, 0.45));
  const cheek = (ear: V3, eye: V3): V3 => { const c = add(mul(av.nose, 0.4), mul(ear, 0.6)); return [c[0], (eye[1] + av.nose[1]) / 2, (c[2] + eye[2]) / 2]; };
  return [av.eyeL, av.eyeR, av.nose, mouth, av.chin, forehead, cheek(av.earL, av.eyeL), cheek(av.earR, av.eyeR)];
}

/**
 * Face points nearer than this (frontal plane, metres) to a FINGER joint are the hand's to cover, not the arm's: a
 * finger on the eye hides the eye. The palm and wrist do not excuse anything (a wrist across the mouth is the
 * forearm's fault), and the zone is small, so a forearm crossing the nose still counts.
 */
export const HAND_ZONE = 0.035;
/** MediaPipe hand indices of the finger joints (everything but the wrist and the knuckles: the fingers proper) */
export const FINGER_JOINTS = [2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20];
/** the face points no hand is at (see HAND_ZONE) */
export const visibleFace = (face: V3[], handPts: V3[]) => face.filter((f) => handPts.every((h) => len2(sub(f, h)) > HAND_ZONE));

/** an arm segment as a capsule (world, metres) */
export interface Seg { a: V3; b: V3; r: number }
/** world point -> [x / depth, y / depth, depth] in the render camera (depth > 0 in front of it) */
export type Project = (p: V3) => V3;

/**
 * How much the capsules cover the face points as seen from the camera: per face point, the deepest overlap
 * (0..1, 1 = the capsule axis passes right over it) of any capsule part that is nearer the camera than the point.
 * Returns the soft total (for the solver, continuous in the arm pose) and the count of covered points (metric).
 */
export function faceOcclusion(face: V3[], segs: Seg[], proj: Project, steps = 10): { soft: number; count: number } {
  const fp = face.map(proj);
  const cover = new Array(face.length).fill(0);
  for (const s of segs) {
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const q = proj([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t, s.a[2] + (s.b[2] - s.a[2]) * t]);
      if (q[2] <= 1e-6) continue;
      const rr = s.r / q[2];
      fp.forEach((f, j) => {
        if (q[2] >= f[2] - 0.01) return; // not in front of the face point
        const d = Math.hypot(q[0] - f[0], q[1] - f[1]);
        if (d < rr) cover[j] = Math.max(cover[j], 1 - d / rr);
      });
    }
  }
  return { soft: cover.reduce((a, b) => a + b, 0), count: cover.filter((c) => c > 0).length };
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Two-bone IK with the elbow's swivel chosen, not just copied. The elbow can be anywhere on a circle around the
 * shoulder-wrist line; each candidate is scored by `cost(elbow)` (e.g. arm in front of the face) plus a pull
 * toward the tracked elbow's swivel (`pole`) and toward the previous frame's (`prev`, radians, null = none).
 * Returns the elbow, the reachable wrist and the swivel angle (measured from "elbow straight down").
 */
export function swivelIK(s: V3, t: V3, l1: number, l2: number, pole: V3, cost: (elbow: V3) => number,
  prev: number | null, w = { pole: 0.3, prev: 2.0 }): { elbow: V3; wrist: V3; theta: number } {
  const base = twoBoneIK(s, t, l1, l2, pole);
  const wrist = base.wrist;
  const d = sub(wrist, s), dist = len(d), u = mul(d, 1 / dist);
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const c = add(s, mul(u, a));
  // circle frame: e1 = "down" perpendicular to the arm line (or back, if the arm points straight down)
  let e1 = sub([0, -1, 0], mul(u, -u[1]));
  if (len(e1) < 1e-3) e1 = sub([0, 0, -1], mul(u, -u[2]));
  e1 = mul(e1, 1 / len(e1));
  const e2: V3 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
  const at = (th: number): V3 => add(c, add(mul(e1, h * Math.cos(th)), mul(e2, h * Math.sin(th))));
  const pv = sub(base.elbow, c);
  const th0 = Math.atan2(pv[0] * e2[0] + pv[1] * e2[1] + pv[2] * e2[2], pv[0] * e1[0] + pv[1] * e1[1] + pv[2] * e1[2]);
  const score = (th: number) => cost(at(th)) + w.pole * wrapPi(th - th0) ** 2 + (prev === null ? 0 : w.prev * wrapPi(th - prev) ** 2);
  if (h < 1e-4) return { elbow: base.elbow, wrist, theta: th0 };
  let best = th0, bestS = score(th0);
  const N = 48;
  for (let k = 0; k < N; k++) {
    const th = th0 + (2 * Math.PI * k) / N;
    const sc = score(th);
    if (sc < bestS - 1e-9) { best = th; bestS = sc; }
  }
  for (let step = Math.PI / N; step > 0.003; step /= 2) { // local refinement
    for (const th of [best - step, best + step]) { const sc = score(th); if (sc < bestS) { best = th; bestS = sc; } }
  }
  return { elbow: at(best), wrist, theta: wrapPi(best) };
}

/** arm capsule radii (metres, sleeve included) for the face-occlusion test */
export const ARM_RADIUS = { upper: 0.045, fore: 0.038 };
/** the arms as capsules: shoulder -> elbow -> wrist (the sleeve cuff at the wrist included) */
export function armSegs(s: V3, e: V3, w: V3): Seg[] {
  return [{ a: s, b: e, r: ARM_RADIUS.upper }, { a: e, b: w, r: ARM_RADIUS.fore }];
}

/**
 * Cost of an elbow position for an arm from shoulder `s` to wrist `w`: the arm covering the face in the camera
 * (dominant), then what a signer touching the face does not do: elbow above the shoulder, behind the shoulder
 * plane, or in toward the body's midline (`out` = unit vector from the sternum to this shoulder). `handPts`: the
 * hand's finger joints at the target (face points under them are the hand's, see HAND_ZONE).
 */
export function elbowCost(face: V3[], proj: Project, s: V3, w: V3, l1: number, out: V3, handPts: V3[] = [w]) {
  face = visibleFace(face, handPts);
  return (e: V3) => {
    const d = sub(e, s);
    return 20 * faceOcclusion(face, armSegs(s, e, w), proj, 6).soft
      + 0.5 * Math.max(0, d[1] / l1) + 3 * Math.max(0, -d[2] / l1) + 2 * Math.max(0, -(d[0] * out[0] + d[1] * out[1] + d[2] * out[2]) / l1);
  };
}
