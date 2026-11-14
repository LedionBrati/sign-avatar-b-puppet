// Small geometry helpers shared by the skeleton view, the VRM driver and the tests. No DOM.
import type { MotionFrame, Vec3, Vec4 } from "./motion";

export const sub3 = (a: number[], b: number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross3 = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len3 = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: number[]): Vec3 => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const angleDeg = (a: number[], b: number[]) =>
  (Math.acos(Math.max(-1, Math.min(1, dot3(norm3(a), norm3(b))))) * 180) / Math.PI;

/** MediaPipe hand indices */
export const HAND = { WRIST: 0, THUMB: [1, 2, 3, 4], INDEX: [5, 6, 7, 8], MIDDLE: [9, 10, 11, 12], RING: [13, 14, 15, 16], PINKY: [17, 18, 19, 20] } as const;

/**
 * Unit vector pointing OUT of the palm, in MediaPipe axes (x image-right, y down, z away from the camera).
 * z < 0 means the palm faces the camera.
 * `scale` converts image coords to a metric-ish space (x * width, y * height, z * width); pass [1,1,1] for world points.
 */
export function palmNormal(hand: Vec3[], side: "left" | "right", scale: Vec3 = [1, 1, 1]): Vec3 {
  const s = (p: Vec3): Vec3 => [p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]];
  const w = s(hand[0]), idx = s(hand[5]), pky = s(hand[17]);
  const a = sub3(idx, w), b = sub3(pky, w);
  // right hand: (index - wrist) x (pinky - wrist) points out of the palm; the left hand is the mirror image
  return norm3(side === "right" ? cross3(a, b) : cross3(b, a));
}

export function palmCenter(hand: Vec3[]): Vec3 {
  const ids = [0, 5, 9, 13, 17];
  const c: Vec3 = [0, 0, 0];
  for (const i of ids) for (let d = 0; d < 3; d++) c[d] += hand[i][d] / ids.length;
  return c;
}

/** MediaPipe axes (y down, z away from camera) -> three.js axes for an avatar that faces the camera (+Z toward camera, y up). */
export const mpToThree = (v: number[]): Vec3 => [v[0], -v[1], -v[2]];

const flipImg = <T extends Vec3 | Vec4>(p: T): T => { const q = p.slice() as T; q[0] = 1 - q[0]; return q; };
const flipWorld = <T extends Vec3 | Vec4>(p: T): T => { const q = p.slice() as T; q[0] = -q[0]; return q; };

/** MediaPipe pose index pairs that swap under a left-right mirror. */
const POSE_SWAP: [number, number][] = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
function swapPose<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (const [a, b] of POSE_SWAP) { out[a] = arr[b]; out[b] = arr[a]; }
  return out;
}

/**
 * Mirror a frame left-right AND swap the left/right labels, so it describes the mirror-image person.
 * Used to feed kalidokit, which is written for selfie (mirror) mode: its "Right" arm reads the
 * subject's LEFT landmarks. Feeding it the mirrored frame makes avatar-right follow subject-right.
 * The face mesh is only flipped (its 478 indices are not left/right symmetric pairs we can swap
 * cheaply), which is what kalidokit's head solve needs: yaw/roll change sign.
 */
export function mirrorFrame(f: MotionFrame): MotionFrame {
  return {
    ...f,
    pose: f.pose ? swapPose(f.pose.map(flipImg)) : null,
    poseWorld: f.poseWorld ? swapPose(f.poseWorld.map(flipWorld)) : null,
    face: f.face ? f.face.map(flipImg) : null,
    leftHand: f.rightHand ? f.rightHand.map(flipImg) : null,
    rightHand: f.leftHand ? f.leftHand.map(flipImg) : null,
    leftHandWorld: f.rightHandWorld ? f.rightHandWorld.map(flipWorld) : null,
    rightHandWorld: f.leftHandWorld ? f.leftHandWorld.map(flipWorld) : null,
  };
}
