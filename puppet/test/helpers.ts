import type { Motion, MotionFrame, Vec3, Vec4 } from "../src/motion";

/** A tiny valid motion: every point of every part sits at (value, value, value). */
export function makeMotion(n: number, value: (i: number) => number, opts: Partial<Motion> = {}): Motion {
  const pts = (count: number, v: number): Vec3[] => Array.from({ length: count }, () => [v, v, v] as Vec3);
  const frames: MotionFrame[] = Array.from({ length: n }, (_, i) => {
    const v = value(i);
    return {
      i, t: i / (opts.fps ?? 24),
      pose: Array.from({ length: 33 }, () => [v, v, v, 1] as Vec4),
      poseWorld: pts(33, v), face: pts(478, v),
      leftHand: pts(21, v), rightHand: pts(21, v),
    };
  });
  return {
    version: 1, name: "test", gloss: null, source: { file: null }, fps: 24, width: 540, height: 720,
    dominant_hand: "right", mirrored: false, cleaned: false, frames, ...opts,
  };
}
