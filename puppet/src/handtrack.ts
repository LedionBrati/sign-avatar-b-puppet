// Hand orientation over a whole clip: never flip a palm, fill what the tracker missed.
//
// The tracker sometimes reads a hand inside out for a few frames (palm normal 180 degrees off), and loses hands
// that move fast or leave the frame. Solving each frame on its own turns that into palms that flip and hands that
// drop to rest and come back. Here the per-frame hand orientations of a clip are cleaned as one sequence:
//  1. quaternions put in one hemisphere (q and -q are the same rotation);
//  2. runs of frames that jump more than FLIP_DEG away from BOTH neighbours, which agree with each other, and last
//     at most maxRunS, are tracker flips: rejected (also a short run at a clip edge that jumps from a long one);
//  3. what is left may not turn faster than maxDegS (a real wrist does not turn 90 degrees in one frame);
//  4. rejected and untracked frames are filled by slerp between the good neighbours (the edges of the span hold
//     the neighbour pose for a moment, like a signer pausing), up to maxFillS; at the clip edges, and on either
//     side of a longer gap, the nearest good pose is held for holdS, then the hand is left untracked.
// Finger joint angles are filled the same way (linear) on the same frames.
// No three.js: plain arrays, so it runs in tests.

import type { HandAngles, V3 } from "./hand";
import { FINGERS } from "./hand";

export type Q = [number, number, number, number]; // x, y, z, w
export type HandStatus = "tracked" | "filled" | "held" | "rejected-filled" | null;

export interface HandTrackOptions {
  /** a jump bigger than this (degrees) from both neighbours marks a flip */
  flipDeg: number;
  /** longest run (seconds) that can be rejected as a flip */
  maxRunS: number;
  /** fastest believable wrist turn, degrees per second */
  maxDegS: number;
  /** longest gap (seconds) filled by interpolation */
  maxFillS: number;
  /** how long (seconds) the nearest good pose is held at a clip edge or beside a long gap */
  holdS: number;
  /** frames at each side of a filled span that hold the neighbour pose before the slerp starts */
  edgeHold: number;
}
export const DEFAULT_HANDTRACK: HandTrackOptions = { flipDeg: 90, maxRunS: 0.6, maxDegS: 720, maxFillS: 1.0, holdS: 0.25, edgeHold: 1 };

// ---------------------------------------------------------------- quaternion helpers
const dot4 = (a: Q, b: Q) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const neg = (a: Q): Q => [-a[0], -a[1], -a[2], -a[3]];
const norm4 = (a: Q): Q => { const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1; return [a[0] / l, a[1] / l, a[2] / l, a[3] / l]; };
/** angle between two rotations, degrees */
export const quatAngleDeg = (a: Q, b: Q) => (2 * Math.acos(Math.min(1, Math.abs(dot4(a, b)))) * 180) / Math.PI;

export function slerp(a: Q, b: Q, t: number): Q {
  let d = dot4(a, b);
  const bb = d < 0 ? neg(b) : b;
  d = Math.abs(d);
  if (d > 0.9995) return norm4([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}

/** rotation whose x axis is `x` and whose y axis is `y` (orthogonalised); null if degenerate */
export function basisQ(x: V3, y: V3): Q | null {
  const lx = Math.hypot(...x);
  if (lx < 1e-9) return null;
  const X: V3 = [x[0] / lx, x[1] / lx, x[2] / lx];
  const d = y[0] * X[0] + y[1] * X[1] + y[2] * X[2];
  let Y: V3 = [y[0] - X[0] * d, y[1] - X[1] * d, y[2] - X[2] * d];
  const ly = Math.hypot(...Y);
  if (ly < 1e-9) return null;
  Y = [Y[0] / ly, Y[1] / ly, Y[2] / ly];
  const Z: V3 = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];
  // rotation matrix columns X, Y, Z -> quaternion
  const m00 = X[0], m10 = X[1], m20 = X[2], m01 = Y[0], m11 = Y[1], m21 = Y[2], m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  let q: Q;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
  return norm4(q);
}

/** the x and y axes of a rotation (inverse of basisQ) */
export function axesOf(q: Q): { x: V3; y: V3 } {
  const [x, y, z, w] = q;
  return {
    x: [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    y: [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
  };
}

// ---------------------------------------------------------------- the clean-up
/**
 * Clean one hand's orientation sequence (null = no hand that frame). Returns the cleaned sequence and what
 * happened at every frame. `reach[i]` false = the arm is not tracked at frame i: nothing is filled there.
 */
export function cleanHandTrack(seq: (Q | null)[], fps: number, opts: HandTrackOptions = DEFAULT_HANDTRACK,
  reach?: boolean[]): { q: (Q | null)[]; status: HandStatus[]; rejected: number; clamped: number } {
  const n = seq.length;
  const q: (Q | null)[] = seq.map((x) => (x ? norm4(x) : null));
  // 1. one hemisphere, following the sequence
  let last: Q | null = null;
  for (let i = 0; i < n; i++) { const x = q[i]; if (!x) continue; if (last && dot4(last, x) < 0) q[i] = neg(x); last = q[i]; }
  // 2. runs of mutually consistent valid frames
  const valid = q.map((x) => !!x);
  const reject = new Array(n).fill(false);
  for (let pass = 0; pass < 3; pass++) {
    const runs: { a: number; b: number }[] = []; // inclusive frame ranges, gaps allowed inside
    let cur: { a: number; b: number } | null = null;
    for (let i = 0; i < n; i++) {
      if (!valid[i] || reject[i]) continue;
      if (cur && quatAngleDeg(q[cur.b]!, q[i]!) < opts.flipDeg * 0.66) cur.b = i;
      else { cur = { a: i, b: i }; runs.push(cur); }
    }
    const frames = (r: { a: number; b: number }) => { let c = 0; for (let i = r.a; i <= r.b; i++) if (valid[i] && !reject[i]) c++; return c; };
    let changed = false;
    for (let j = 0; j < runs.length; j++) {
      const r = runs[j], prev = runs[j - 1], next = runs[j + 1];
      if (frames(r) > opts.maxRunS * fps) continue;
      const jumpPrev = prev ? quatAngleDeg(q[prev.b]!, q[r.a]!) > opts.flipDeg : null;
      const jumpNext = next ? quatAngleDeg(q[r.b]!, q[next.a]!) > opts.flipDeg : null;
      let bad = false;
      if (prev && next) bad = !!jumpPrev && !!jumpNext && quatAngleDeg(q[prev.b]!, q[next.a]!) < opts.flipDeg;
      else if (prev) bad = !!jumpPrev && frames(prev) > frames(r);
      else if (next) bad = !!jumpNext && frames(next) > frames(r);
      if (bad) { for (let i = r.a; i <= r.b; i++) if (valid[i]) reject[i] = true; changed = true; }
    }
    if (!changed) break;
  }
  // 3. turn rate limit over the accepted frames (forward)
  const ok = q.map((x, i) => !!x && !reject[i]);
  const maxStep = opts.maxDegS / fps;
  let clamped = 0, pi = -1;
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue;
    if (pi >= 0) {
      const lim = maxStep * (i - pi), ang = quatAngleDeg(q[pi]!, q[i]!);
      if (ang > lim) { q[i] = slerp(q[pi]!, q[i]!, lim / ang); clamped++; }
    }
    pi = i;
  }
  // 4. fill
  const out: (Q | null)[] = q.map((x, i) => (ok[i] ? x : null));
  const status: HandStatus[] = ok.map((o) => (o ? "tracked" : null));
  const maxFill = Math.round(opts.maxFillS * fps), hold = Math.round(opts.holdS * fps);
  for (let i = 0; i < n; i++) {
    if (ok[i]) continue;
    let j = i;
    while (j < n && !ok[j]) j++; // span [i, j)
    const a = i - 1, b = j < n ? j : -1, g = j - i;
    const tag = (k: number) => (reject[k] ? "rejected-filled" : "filled") as HandStatus;
    if (a >= 0 && b >= 0 && g <= maxFill) {
      const e = Math.min(opts.edgeHold, Math.floor(g / 3));
      for (let k = i; k < j; k++) {
        const t = g - 2 * e > 0 ? Math.min(1, Math.max(0, (k - i - e + 1) / (g - 2 * e + 1))) : (k - i + 1) / (g + 1);
        const s = t * t * (3 - 2 * t);
        out[k] = slerp(q[a]!, q[b]!, s); status[k] = tag(k);
      }
    } else {
      for (let k = i; k < Math.min(j, i + hold); k++) if (a >= 0) { out[k] = q[a]; status[k] = "held"; }
      for (let k = j - 1; k >= Math.max(i, j - hold); k--) if (b >= 0 && !out[k]) { out[k] = q[b]; status[k] = "held"; }
    }
    i = j - 1;
  }
  if (reach) for (let i = 0; i < n; i++) if (!reach[i] && status[i] !== "tracked") { out[i] = null; status[i] = null; }
  return { q: out, status, rejected: reject.filter(Boolean).length, clamped };
}

/** Fill finger angles on the frames the orientation clean-up filled (linear between the good neighbours, held at edges). */
export function fillAngles(seq: (HandAngles | null)[], status: HandStatus[]): (HandAngles | null)[] {
  const n = seq.length;
  const good = (i: number) => status[i] === "tracked" && !!seq[i];
  const out = seq.map((a, i) => (good(i) ? a : null));
  for (let i = 0; i < n; i++) {
    if (!status[i] || good(i)) continue;
    let a = i - 1; while (a >= 0 && !good(a)) a--;
    let b = i + 1; while (b < n && !good(b)) b++;
    const A = a >= 0 ? seq[a]! : null, B = b < n ? seq[b]! : null;
    if (!A && !B) continue;
    const t = A && B ? (i - a) / (b - a) : A ? 0 : 1;
    const s = t * t * (3 - 2 * t);
    const P = A ?? B!, R = B ?? A!;
    out[i] = Object.fromEntries(FINGERS.map((f) => [f, P[f].map((v, k) => v + (R[f][k] - v) * s)])) as HandAngles;
  }
  return out;
}
