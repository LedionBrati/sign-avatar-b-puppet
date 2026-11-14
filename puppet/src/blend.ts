// Join motion clips into one sentence: per-clip speed and holds, then a short cross-blend
// between neighbours (README §6.3). Pure functions, no DOM.
//
// We blend landmark POSITIONS (eased weight), not rotations: the motion file stores points,
// and the puppet re-solves rotations from the blended points every frame. If a rotation-space
// format is added later, swap lerpPoints for a slerp on quaternions.

import type { Motion, MotionFrame, Vec3, Vec4 } from "./motion";

export interface ClipSpec {
  motion: Motion;
  /** playback speed, 2 = twice as fast. Default 1. */
  speed?: number;
  /** seconds to freeze the first / last frame */
  holdStart?: number;
  holdEnd?: number;
}

export interface BlendOptions {
  /** cross-blend length in seconds (default 0.2). Clamped to half of the shorter neighbour. */
  blend?: number;
  /** output fps (default: the first clip's fps) */
  fps?: number;
}

export interface Segment { name: string; gloss: string | null; start: number; end: number }

/** smoothstep easing 0..1 */
export const ease = (w: number): number => (w <= 0 ? 0 : w >= 1 ? 1 : w * w * (3 - 2 * w));

type Pts = Vec3[] | Vec4[];

/** Linear interpolation of two point arrays. A missing side (null) takes the other one as is. */
export function lerpPoints<T extends Pts>(a: T | null | undefined, b: T | null | undefined, w: number): T | null {
  if (!a) return (b ?? null) as T | null;
  if (!b || a.length !== b.length) return a;
  return a.map((p, k) => p.map((v, d) => v + ((b[k] as number[])[d] - v) * w)) as T;
}

function lerpShapes(a: Record<string, number> | null | undefined, b: Record<string, number> | null | undefined, w: number) {
  if (!a) return b ?? null;
  if (!b) return a;
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = (a[k] ?? 0) + ((b[k] ?? 0) - (a[k] ?? 0)) * w;
  return out;
}

/** Interpolate every part of two frames (w = 0 gives a, w = 1 gives b). */
export function lerpFrame(a: MotionFrame, b: MotionFrame, w: number): MotionFrame {
  return {
    i: a.i,
    t: a.t + (b.t - a.t) * w,
    pose: lerpPoints(a.pose, b.pose, w),
    poseWorld: lerpPoints(a.poseWorld, b.poseWorld, w),
    face: lerpPoints(a.face, b.face, w),
    faceBlendshapes: lerpShapes(a.faceBlendshapes, b.faceBlendshapes, w),
    leftHand: lerpPoints(a.leftHand, b.leftHand, w),
    leftHandWorld: lerpPoints(a.leftHandWorld, b.leftHandWorld, w),
    rightHand: lerpPoints(a.rightHand, b.rightHand, w),
    rightHandWorld: lerpPoints(a.rightHandWorld, b.rightHandWorld, w),
  };
}

/** Sample a clip at source time t (seconds from its first frame), interpolating between frames. */
export function sampleAt(m: Motion, t: number): MotionFrame {
  const f = m.frames;
  const x = (t - f[0].t) * m.fps; // fractional frame index (assumes even spacing, as FORMAT.md does)
  if (x <= 0) return f[0];
  if (x >= f.length - 1) return f[f.length - 1];
  const k = Math.floor(x);
  return lerpFrame(f[k], f[k + 1], x - k);
}

/** Apply speed and holds, resampled to `fps`. */
export function retime(spec: ClipSpec, fps: number): MotionFrame[] {
  const { motion: m, speed = 1, holdStart = 0, holdEnd = 0 } = spec;
  if (!(speed > 0)) throw new Error(`speed must be > 0, got ${speed}`);
  const srcDur = (m.frames.length - 1) / m.fps; // first to last frame
  const n = Math.max(1, Math.round((holdStart + srcDur / speed + holdEnd) * fps) + 1);
  const out: MotionFrame[] = [];
  for (let k = 0; k < n; k++) {
    const tOut = k / fps;
    const tSrc = Math.min(srcDur, Math.max(0, (tOut - holdStart) * speed));
    out.push(sampleAt(m, m.frames[0].t + tSrc));
  }
  return out;
}

/**
 * Concatenate clips with an eased cross-blend of `blend` seconds where they meet.
 * The last frames of clip A overlap the first frames of clip B, so the result is
 * shorter than the sum by (clips - 1) x blend.
 */
export function concatClips(clips: ClipSpec[], opts: BlendOptions = {}): { motion: Motion; segments: Segment[] } {
  if (clips.length === 0) throw new Error("concatClips: no clips");
  const fps = opts.fps ?? clips[0].motion.fps;
  const blendS = opts.blend ?? 0.2;
  const parts = clips.map((c) => retime(c, fps));
  let frames: MotionFrame[] = parts[0].slice();
  const segments: Segment[] = [{ name: clips[0].motion.name, gloss: clips[0].motion.gloss, start: 0, end: frames.length - 1 }];
  for (let c = 1; c < parts.length; c++) {
    const next = parts[c];
    const overlap = Math.max(0, Math.min(Math.round(blendS * fps), Math.floor(frames.length / 2), Math.floor(next.length / 2)));
    const startOut = frames.length - overlap;
    for (let k = 0; k < overlap; k++) {
      const w = ease((k + 1) / (overlap + 1));
      frames[startOut + k] = lerpFrame(frames[startOut + k], next[k], w);
    }
    frames = frames.concat(next.slice(overlap));
    segments.push({ name: clips[c].motion.name, gloss: clips[c].motion.gloss, start: startOut, end: frames.length - 1 });
  }
  frames = frames.map((f, i) => ({ ...f, i, t: Math.round((i / fps) * 1e4) / 1e4 }));
  const first = clips[0].motion;
  const glosses = clips.map((c) => c.motion.gloss).filter(Boolean);
  const motion: Motion = {
    version: 1,
    name: clips.map((c) => c.motion.name).join("+"),
    motion_id: null, // a blend is a sentence, not a catalog sign
    gloss: glosses.length ? glosses.join(" ") : null,
    source: { file: null, dataset: "blend", license: [...new Set(clips.map((c) => c.motion.source?.license).filter(Boolean))].join("; ") || null },
    fps,
    width: first.width,
    height: first.height,
    dominant_hand: first.dominant_hand,
    mirrored: clips.some((c) => c.motion.mirrored),
    extractor: { name: "puppet/src/blend.ts", version: "1", model: null },
    cleaned: clips.every((c) => c.motion.cleaned),
    cleanup: { blend_s: blendS, clips: clips.map((c) => ({ name: c.motion.name, speed: c.speed ?? 1, holdStart: c.holdStart ?? 0, holdEnd: c.holdEnd ?? 0 })) },
    frames,
  };
  return { motion, segments };
}
