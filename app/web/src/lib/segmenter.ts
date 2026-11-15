// Cuts signs out of the landmark stream. arm() -> "armed". When hands appear it keeps a short pre-roll; once they
// move, recording starts. A segment ends when the hands are gone or still for ~0.4 s, after 4 s (to split long
// signing), or on stop(). Continuous (the default): after each segment it goes straight back to "armed", forever,
// until cancel(); one-shot: back to "idle".
import { handsVisible, packFrame, packSegment, type HolisticFrame, type Point } from "@signlayer/core";

export type SegState = "idle" | "armed" | "recording";

export const SEG = {
  goneMs: 400, // hands out of view this long -> end the segment
  stillMs: 600, // hands still this long (after moving) -> end the segment (short holds inside a sign don't cut it)
  minMs: 500, // a "still" cut never comes sooner than this after the start
  maxMs: 4000, // cap per segment (continuous mode keeps reading right after)
  preRoll: 8, // frames kept from before the motion starts
  minFrames: 4, // shorter segments are dropped
  moveThresh: 0.004, // mean normalized displacement per frame counted as motion
};

const KEY = [0, 4, 8, 12, 20]; // wrist + finger tips

/** Mean wrist + fingertip displacement between two frames (a hand appearing or vanishing counts as 0.02). */
export function motion(a: HolisticFrame | null, b: HolisticFrame): number {
  if (!a) return 0;
  let sum = 0, n = 0;
  for (const k of ["leftHand", "rightHand"] as const) {
    const p = a[k], q = b[k];
    if (!p?.length || !q?.length) { if (p?.length || q?.length) { sum += 0.02; n++; } continue; }
    for (const i of KEY) { const u = p[i] as Point, v = q[i] as Point; sum += Math.hypot(u.x - v.x, u.y - v.y); n++; }
  }
  return n ? sum / n : 0;
}

export interface SegmentDone { frames: Float32Array; count: number; ms: number; reason: "gone" | "still" | "max" | "tap" }

export function createSegmenter(onDone: (s: SegmentDone) => void, onState: (s: SegState) => void, { continuous = true } = {}) {
  let state: SegState = "idle";
  let buf: Float32Array[] = [];
  let lastHandIdx = -1;
  let prev: HolisticFrame | null = null;
  let moved = false;
  let t0 = 0, lastHandT = 0, lastMoveT = 0, noHand = 0, still = 0;
  const set = (s: SegState) => { if (s !== state) { state = s; onState(s); } };
  const reset = () => { buf = []; lastHandIdx = -1; prev = null; moved = false; noHand = 0; still = 0; };

  function finish(reason: SegmentDone["reason"], t: number) {
    const keep = buf.slice(0, Math.max(lastHandIdx + 3, 0)); // drop the trailing frames without hands, keep 2
    reset();
    set(continuous ? "armed" : "idle");
    if (keep.length >= SEG.minFrames) onDone({ frames: packSegment(keep), count: Math.min(keep.length, 384), ms: t - t0, reason });
    else onDone({ frames: new Float32Array(0), count: 0, ms: t - t0, reason });
  }

  return {
    get state() { return state; },
    arm() { reset(); set("armed"); },
    cancel() { reset(); set("idle"); },
    /** Recording: cut now (continuous: keeps reading). Armed: cancel. */
    stop(t = performance.now()) { if (state === "recording") finish("tap", t); else if (state === "armed") { reset(); set("idle"); } },
    push(f: HolisticFrame, t: number) {
      if (state === "idle") return;
      const hands = handsVisible(f);
      const m = motion(prev, f);
      prev = f;
      if (state === "armed") {
        if (!hands) { buf = []; lastHandIdx = -1; return; }
        buf.push(packFrame(f));
        if (buf.length > SEG.preRoll) buf.shift();
        lastHandIdx = buf.length - 1;
        if (m > SEG.moveThresh) { set("recording"); t0 = t; lastHandT = t; lastMoveT = t; moved = true; }
        return;
      }
      buf.push(packFrame(f));
      if (hands) { lastHandIdx = buf.length - 1; lastHandT = t; noHand = 0; } else noHand++;
      if (m > SEG.moveThresh) { lastMoveT = t; moved = true; still = 0; } else still++;
      // Time AND at least 2 frames, so a slow device (a few fps) doesn't cut on one dropped detection.
      if (noHand >= 2 && t - lastHandT > SEG.goneMs) return finish("gone", t);
      if (moved && still >= 2 && t - lastMoveT > SEG.stillMs && t - t0 > SEG.minMs) return finish("still", t);
      if (t - t0 > SEG.maxMs || buf.length >= 384) return finish("max", t);
    },
  };
}
export type Segmenter = ReturnType<typeof createSegmenter>;
