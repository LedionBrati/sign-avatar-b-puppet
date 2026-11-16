// Cuts signs out of the landmark stream with the shared cutter (app/core/src/segment.ts: hands up / rest pose,
// motion energy with hysteresis, min / max sign length, cut at the slowest moment when signing runs on).
// arm() -> "armed"; once a hand is up and moving -> "recording"; each finished sign calls onDone with its frames
// (plus a few frames of context). A dropped cut (a twitch, the hands going back to rest) calls onDone with count 0,
// so the caller still knows the hands settled. Continuous (the default): back to "armed" after each sign, until
// cancel(); one-shot: back to "idle". stop() cuts now (the enrollment countdown and the Spell button use it).
import { createCutter, packFrame, packSegment, MAX_FRAMES, type HolisticFrame, type Point, type SegConfig, type SegReason } from "@signlayer/core";

export type SegState = "idle" | "armed" | "recording";

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

export interface SegmentDone { frames: Float32Array; count: number; ms: number; reason: SegReason | "tap" }

/** Fingerspelling: letters are held, so only a long pause ends a word, and the hands may move down while spelling. */
export const SPELL_SEG: Partial<SegConfig> = { pauseMs: 900, maxMs: 8000, maxDescent: 1.01, minPath: 0.2 };

export function createSegmenter(onDone: (s: SegmentDone) => void, onState: (s: SegState) => void,
  { continuous = true, config = {} as Partial<SegConfig> } = {}) {
  let cutter = createCutter(config);
  let state: SegState = "idle";
  let buf: { f: Float32Array; t: number }[] = []; // frames since the cutter's frame `base`
  let base = 0;
  const set = (s: SegState) => { if (s !== state) { state = s; onState(s); } };
  const reset = () => { cutter.reset(); buf = []; base = 0; };

  function emit(start: number, end: number, reason: SegmentDone["reason"]) {
    const a = Math.max(0, start - base), b = Math.min(buf.length, end - base);
    const seg = buf.slice(a, b);
    const ms = seg.length ? seg[seg.length - 1]!.t - seg[0]!.t : 0;
    const frames = seg.slice(-MAX_FRAMES).map((s) => s.f);
    onDone(frames.length ? { frames: packSegment(frames), count: frames.length, ms, reason } : { frames: new Float32Array(0), count: 0, ms, reason });
  }

  return {
    get state() { return state; },
    configure(c: Partial<SegConfig>) { cutter = createCutter(c); buf = []; base = 0; if (state !== "idle") set("armed"); },
    arm() { reset(); set("armed"); },
    cancel() { reset(); set("idle"); },
    /** Recording: cut now (continuous: keeps reading). Armed: cancel. */
    stop() {
      if (state === "recording") {
        const cuts = cutter.flush();
        if (cuts.length) for (const c of cuts) emit(c.start, c.end, "tap");
        else onDone({ frames: new Float32Array(0), count: 0, ms: 0, reason: "tap" });
        reset();
        set(continuous ? "armed" : "idle");
      } else if (state === "armed") { reset(); set("idle"); }
    },
    push(f: HolisticFrame, t: number) {
      if (state === "idle") return;
      const packed = packFrame(f);
      buf.push({ f: packed, t });
      const r = cutter.push(packed, t);
      for (const c of r.cuts) emit(c.start, c.end, c.reason);
      if (r.ended && !r.cuts.length) onDone({ frames: new Float32Array(0), count: 0, ms: 0, reason: "rest" });
      if (r.started) set("recording");
      else if (r.ended) {
        if (continuous) set("armed");
        else { reset(); set("idle"); return; }
      }
      // keep only the frames a later cut can still include
      const from = cutter.keepFrom;
      if (from > base) { buf = buf.slice(from - base); base = from; }
    },
  };
}
export type Segmenter = ReturnType<typeof createSegmenter>;
