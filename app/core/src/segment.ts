// Sign -> voice: cut continuous signing into sign segments. Mirror of app/recognizer/segment.py (same rules, same
// numbers; test/segment.test.mjs runs both on one fixture). Input is one packed frame per call (packFrame layout:
// 543 x 3, face 0-467 | left hand 468-488 | pose 489-521 | right hand 522-542, NaN = missing, image coords).
//
// Per frame, in shoulder widths (origin = shoulder midpoint, y down):
//  - hand up: a hand is tracked and its wrist is above upOn; it stays up until it drops below upOff (hysteresis);
//  - speed: mean displacement of the wrist + 5 fingertips per second (over LAG frames, so tracking jitter does not
//    look like motion), smoothed (EMA, tauMs).
// armed -> recording when a hand is up AND moving (speed > moveOn). Recording ends at
//  - rest:  hands tracked but none up for restMs (dropped to the lap / sides),
//  - gone:  no hand tracked for goneMs (out of frame; short tracking dropouts do not cut a sign),
//  - pause: hands up but speed < moveOff for pauseMs (the hold at the end of a sign / between two signs),
//  - max:   longer than maxMs: cut at the slowest moment in the middle part; the rest carries on as the next segment.
// A finished segment is kept only if it lasts minMs, the hands travelled minPath, and its wrist travel is not mostly
// downward (maxDescent: that is the hands going back to rest after a hold). pre / post frames of context.
// Dropped segments still end the activity (onDone gets count 0), so the caller knows the hands settled.

export const SEG = {
  upOn: 1.0,
  upOff: 1.3,
  moveOn: 0.9,
  moveOff: 0.45,
  tauMs: 80,
  pauseMs: 260,
  restMs: 140,
  goneMs: 350,
  minMs: 300,
  maxMs: 3500,
  minPath: 0.5,
  maxDescent: 0.8,
  pre: 3,
  post: 2,
};
export type SegConfig = typeof SEG;

const LH = 468, RH = 522, POSE = 489;
const KEY = [0, 4, 8, 12, 16, 20];
const LAG = 3; // frames: motion is measured against the frame this far back
const P = 3; // floats per point

export type SegReason = "rest" | "gone" | "pause" | "max" | "flush";
export interface Cut { start: number; end: number; reason: SegReason }
interface Obs { up: boolean; hands: boolean; speed: number; dist: number; down: number; wpath: number }

/** Online segmenter over frame indices: push() returns the cuts that finished at this frame (start inclusive,
 *  end exclusive, counted from the first frame pushed after reset). Pure logic; createSignSegmenter wraps it. */
export function createCutter(cfg: Partial<SegConfig> = {}) {
  const c = { ...SEG, ...cfg };
  let i = -1, ring: [number, Float32Array][] = [];
  let sh: [number, number, number] | null = null;
  const up = [false, false];
  let speed = 0, state: "armed" | "recording" = "armed", start = 0;
  let lastUpT = -1e9, lastHandT = -1e9, lastUpI = -1, lastHandI = -1;
  let still: [number, number] | null = null;
  let hist: [number, Obs][] = [];

  function observe(f: Float32Array, t: number): Obs {
    const ax = f[(POSE + 11) * P]!, ay = f[(POSE + 11) * P + 1]!, bx = f[(POSE + 12) * P]!, by = f[(POSE + 12) * P + 1]!;
    if (Number.isFinite(ax) && Number.isFinite(bx)) {
      const w = Math.hypot(ax - bx, ay - by);
      if (w >= 1e-3) {
        const s: [number, number, number] = [(ax + bx) / 2, (ay + by) / 2, w];
        sh = sh ? [0.8 * sh[0] + 0.2 * s[0], 0.8 * sh[1] + 0.2 * s[1], 0.8 * sh[2] + 0.2 * s[2]] : s;
      }
    }
    const [, cy, w] = sh ?? [0.5, 0.45, 0.25];
    let hands = false;
    [LH, RH].forEach((st, h) => {
      if (!Number.isFinite(f[st * P]!)) { up[h] = false; return; }
      hands = true;
      const y = (f[st * P + 1]! - cy) / w;
      up[h] = y < (up[h] ? c.upOff : c.upOn);
    });
    // Displacement against the frame LAG frames back (divided by LAG): tracking jitter does not add up the way it
    // does frame to frame, real motion is the same.
    let dist = 0, n = 0, down = 0, wpath = 0;
    const ref = ring.length === LAG ? ring[0]! : null;
    if (ref) {
      const pf = ref[1];
      for (const st of [LH, RH]) for (const k of KEY) {
        const j = (st + k) * P;
        const px = pf[j]!, qx = f[j]!;
        if (Number.isFinite(px) && Number.isFinite(qx)) {
          const dy = f[j + 1]! - pf[j + 1]!;
          const d = Math.hypot(qx - px, dy);
          dist += d; n++;
          if (k === 0) { wpath += d / w; down += Math.max(0, dy) / w; }
        }
      }
    }
    dist = n ? dist / n / w / LAG : 0;
    wpath /= LAG; down /= LAG;
    const dt = Math.max(ref ? (t - ref[0]) / LAG : 33, 1);
    const a = 1 - Math.exp(-dt / c.tauMs);
    speed += a * (dist / (dt / 1000) - speed);
    ring.push([t, f]);
    if (ring.length > LAG) ring.shift();
    return { up: up[0]! || up[1]!, hands, speed, dist, down, wpath };
  }

  function keep(h: [number, Obs][]) {
    if (h.length < 2) return false;
    const dur = h[h.length - 1]![0] - h[0]![0];
    let path = 0, wp = 0, dn = 0;
    for (let j = 1; j < h.length; j++) { path += h[j]![1].dist; wp += h[j]![1].wpath; dn += h[j]![1].down; }
    return dur >= c.minMs && path >= c.minPath && !(wp > 0 && dn / wp > c.maxDescent);
  }

  function finish(end: number, reason: SegReason, carry = false): { cuts: Cut[]; ended: boolean } {
    const k = end - start;
    const seg = hist.slice(0, k);
    const cuts = keep(seg) ? [{ start, end, reason }] : [];
    if (carry) { hist = hist.slice(k); start = end; } else { state = "armed"; hist = hist.slice(-(c.pre + 1)); }
    still = null;
    return { cuts, ended: !carry };
  }

  function valley(): number {
    const t0 = hist[0]![0], tn = hist[hist.length - 1]![0];
    let best = Infinity, bi = Math.floor(hist.length / 2);
    hist.forEach(([t, o], j) => { if (t - t0 >= c.minMs && tn - t >= c.minMs && o.speed < best) { best = o.speed; bi = j; } });
    return start + bi;
  }

  return {
    get state() { return state; },
    get frame() { return i; },
    /** The first frame a later cut can still include (the caller may drop older frames). */
    get keepFrom() { return state === "recording" ? start : i - c.pre; },
    reset() { i = -1; ring = []; sh = null; up[0] = up[1] = false; speed = 0; state = "armed"; start = 0; lastUpT = lastHandT = -1e9; lastUpI = lastHandI = -1; still = null; hist = []; },
    /** -> cuts finished at this frame, and whether an activity ended (also when its cut was dropped). */
    push(f: Float32Array, t: number): { cuts: Cut[]; ended: boolean; started: boolean } {
      i++;
      const o = observe(f, t);
      if (o.hands) { lastHandT = t; lastHandI = i; }
      if (o.up || !o.hands) lastUpT = t;
      if (o.up) lastUpI = i;
      hist.push([t, o]);
      if (state === "armed") {
        if (hist.length > c.pre + 1) hist.shift();
        if (o.up && o.speed > c.moveOn) { state = "recording"; start = i - (hist.length - 1); still = null; return { cuts: [], ended: false, started: true }; }
        return { cuts: [], ended: false, started: false };
      }
      if (o.speed < c.moveOff) { if (!still) still = [t, i]; } else if (o.speed > c.moveOn * 0.75) still = null;
      const r = (x: { cuts: Cut[]; ended: boolean }) => ({ ...x, started: false });
      if (t - lastHandT > c.goneMs) return r(finish(Math.min(i + 1, lastHandI + 1 + c.post), "gone"));
      if (t - lastUpT > c.restMs) return r(finish(Math.min(i + 1, lastUpI + 1 + c.post), "rest"));
      if (still && o.up && t - still[0] > c.pauseMs) return r(finish(Math.min(i + 1, still[1] + c.post), "pause"));
      if (t - hist[0]![0] > c.maxMs) return r(finish(valley(), "max", true));
      return { cuts: [], ended: false, started: false };
    },
    flush(): Cut[] { return state === "recording" ? finish(i + 1, "flush").cuts : []; },
  };
}
export type Cutter = ReturnType<typeof createCutter>;

/** Run the cutter over a whole recording (packed frames at fps) -> cuts. For tests and offline checks. */
export function cutStream(frames: Float32Array[], fps: number, cfg: Partial<SegConfig> = {}): Cut[] {
  const s = createCutter(cfg);
  const out: Cut[] = [];
  frames.forEach((f, k) => out.push(...s.push(f, (k * 1000) / fps).cuts));
  return [...out, ...s.flush()];
}
