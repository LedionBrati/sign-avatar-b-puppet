// Anatomical hand solver: 21 hand landmarks -> joint angles with joint limits, fitted to the fingertips (IK),
// with a simple no-self-intersection rule and one-euro smoothing. No DOM, no three.js: plain arrays, so it
// runs in tests, in node and in the browser.
//
// Model. Each hand has a palm frame from wrist (0), index knuckle (5), middle knuckle (9) and pinky knuckle (17):
//   y = wrist -> middle knuckle, n = palm normal (out of the palm: fingers curl toward +n), x = toward the index side.
// A finger (index..pinky) is 4 numbers, in radians:
//   [MCP abduction (in the palm plane, + toward the thumb, measured from the finger's own metacarpal),
//    MCP flexion, PIP flexion, DIP flexion]   (flexion + toward the palm, - is hyperextension)
// and moves in one plane: the plane through its metacarpal direction (turned by the abduction) and n.
// The thumb is [CMC abduction (angle in the palm plane from y toward x), CMC flexion (out of the palm plane
// toward n), MCP flexion, IP flexion]; its MCP and IP bend in one plane toward the palm and the little finger.
//
// The same angle reader works on landmarks and on an avatar's posed joints, so "joint-limit violations" are
// counted the same way before and after (see countViolations).

export type V3 = [number, number, number];
export type Side = "left" | "right";
export const FINGERS = ["thumb", "index", "middle", "ring", "pinky"] as const;
export type Finger = (typeof FINGERS)[number];
/** MediaPipe hand landmark indices per finger: base joint (CMC for the thumb, MCP otherwise) .. tip */
export const FINGER_LM: Record<Finger, [number, number, number, number]> = {
  thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20],
};
export const JOINT_NAMES: Record<Finger, [string, string, string, string]> = {
  thumb: ["CMC abd", "CMC flex", "MCP flex", "IP flex"],
  index: ["MCP abd", "MCP flex", "PIP flex", "DIP flex"],
  middle: ["MCP abd", "MCP flex", "PIP flex", "DIP flex"],
  ring: ["MCP abd", "MCP flex", "PIP flex", "DIP flex"],
  pinky: ["MCP abd", "MCP flex", "PIP flex", "DIP flex"],
};

const D = Math.PI / 180;
/**
 * Joint ranges in degrees, [lo, hi] per parameter, from active range-of-motion tables (e.g. Hume et al. 1990;
 * AAOS), kept a little generous so real signing is never clipped: MCP -25..95 (hyperextension to full fist),
 * PIP -5..110, DIP -10..85, thumb CMC -5..80 abduction / -30..65 flexion toward the palm (opposition), thumb
 * MCP -25..65, IP -25..85. Spread is measured from each finger's own metacarpal (wrist -> knuckle), and the
 * metacarpals fan out, so a flat hand already reads index about -18, pinky about +1 (medians over 9,783 WLASL
 * hand-frames); the spread ranges sit around those neutrals.
 */
export const LIMITS_DEG: Record<Finger, { lo: [number, number, number, number]; hi: [number, number, number, number] }> = {
  thumb: { lo: [-5, -30, -25, -25], hi: [80, 65, 65, 85] },
  index: { lo: [-40, -25, -5, -10], hi: [20, 95, 110, 85] },
  middle: { lo: [-30, -25, -5, -10], hi: [20, 95, 110, 85] },
  ring: { lo: [-25, -25, -5, -10], hi: [25, 95, 110, 85] },
  pinky: { lo: [-30, -25, -5, -10], hi: [20, 95, 110, 85] },
};
export const LIMITS: Record<Finger, { lo: number[]; hi: number[] }> = Object.fromEntries(
  FINGERS.map((f) => [f, { lo: LIMITS_DEG[f].lo.map((v) => v * D), hi: LIMITS_DEG[f].hi.map((v) => v * D) }]),
) as any;
/**
 * Range of joint k of finger f, given the finger's other angles. One coupling: a knuckle that bends can spread
 * less (the collateral ligaments tighten), so for index..pinky the spread range shrinks toward 0 (in line with
 * the metacarpal) as the MCP flexes from 30 to 90 degrees, down to 25% of the open-hand range. That is what
 * keeps curled fingers side by side in a fist instead of crossing.
 */
export function jointRange(f: Finger, k: number, q: number[]): [number, number] {
  const lo = LIMITS[f].lo[k], hi = LIMITS[f].hi[k];
  if (f === "thumb" || k !== 0) return [lo, hi];
  const s = 1 - 0.75 * smoothstepRad(30 * D, 90 * D, q[1]);
  return [lo * s, hi * s];
}
function smoothstepRad(a: number, b: number, x: number) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
/** clamp one finger's angles into their (coupled) ranges: flexion first, then the spread that depends on it */
export function clampFinger(f: Finger, q: number[]): number[] {
  const out = q.slice();
  for (let k = 1; k < 4; k++) out[k] = Math.min(LIMITS[f].hi[k], Math.max(LIMITS[f].lo[k], out[k]));
  const [lo, hi] = jointRange(f, 0, out);
  out[0] = Math.min(hi, Math.max(lo, out[0]));
  return out;
}

/** a relaxed hand (degrees): used for the rest pose */
export const RELAXED_DEG: Record<Finger, [number, number, number, number]> = {
  thumb: [35, 20, 10, 10], index: [-12, 12, 18, 8], middle: [-6, 15, 22, 10], ring: [0, 18, 24, 10], pinky: [4, 20, 26, 10],
};

// ---------------------------------------------------------------- vector helpers
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export interface PalmFrame { o: V3; x: V3; y: V3; n: V3 }

/** Palm frame of 21 points (any metric frame). Null when the palm is degenerate. */
export function palmFrame(p: V3[], side: Side): PalmFrame | null {
  const o = p[0];
  const yv = sub(p[9], o);
  if (len(yv) < 1e-6) return null;
  const y = norm(yv);
  const a = sub(p[5], o), b = sub(p[17], o);
  let n = side === "right" ? cross(a, b) : cross(b, a); // geom.ts palmNormal: out of the palm
  n = sub(n, mul(y, dot(n, y)));
  if (len(n) < 1e-9) return null;
  n = norm(n);
  let x = cross(y, n);
  if (dot(x, sub(p[5], p[17])) < 0) x = mul(x, -1);
  return { o, x, y, n };
}
/**
 * palmFrame, but if the fingers say the palm is the other way round, believe the fingers: when three or more
 * of index..pinky bend backwards past 70 degrees (MCP + PIP), no hand can do that, and the usual cause is the
 * tracker reading the hand edge-on with the knuckles swapped, which flips the palm normal. Flipping n turns those
 * into ordinary curls toward the palm. `flipped` says whether it happened.
 */
export function palmFrameRobust(p: V3[], side: Side): (PalmFrame & { flipped: boolean }) | null {
  const F = palmFrame(p, side);
  if (!F) return null;
  const a = readAngles(p.map((q) => toLocal(F, q)));
  const back = (["index", "middle", "ring", "pinky"] as Finger[]).filter((f) => a[f][1] + a[f][2] < -70 * D).length;
  if (back < 3) return { ...F, flipped: false };
  return { o: F.o, x: F.x, y: F.y, n: mul(F.n, -1), flipped: true }; // x stays toward the index side
}

export const toLocal = (F: PalmFrame, p: V3): V3 => { const d = sub(p, F.o); return [dot(d, F.x), dot(d, F.y), dot(d, F.n)]; };
export const dirToWorld = (F: PalmFrame, l: V3): V3 => add(add(mul(F.x, l[0]), mul(F.y, l[1])), mul(F.n, l[2]));
export const toWorld = (F: PalmFrame, l: V3): V3 => add(F.o, dirToWorld(F, l));

/** angle in the palm plane, from +y toward +x */
const planeAngle = (v: V3) => Math.atan2(v[0], v[1]);
/** thumb flexion leans across the palm: 60 degrees from n toward -x */
const THUMB_BEND: V3 = [-Math.sin(60 * D), 0, Math.cos(60 * D)];

function thumbPlane(t1: V3): V3 {
  const u = sub(THUMB_BEND, mul(t1, dot(THUMB_BEND, t1)));
  return len(u) < 1e-6 ? [0, 0, 1] : norm(u);
}
/** normal of the plane the thumb bends in, for a metacarpal direction t1 (palm-local): carries the thumb's roll */
export function thumbPlaneNormal(t1: V3): V3 {
  return norm(cross(norm(t1), thumbPlane(norm(t1))));
}

/** Joint angles (radians) of all five fingers from 21 points already in palm-local coordinates. */
export function readAngles(L: V3[]): Record<Finger, number[]> {
  const out = {} as Record<Finger, number[]>;
  for (const f of FINGERS) {
    const [a, b, c, d] = FINGER_LM[f];
    const d1 = norm(sub(L[b], L[a])), d2 = norm(sub(L[c], L[b])), d3 = norm(sub(L[d], L[c]));
    if (f === "thumb") {
      const alpha = Math.atan2(d1[0], d1[1]);
      const beta = Math.asin(clamp(d1[2], -1, 1));
      const u = thumbPlane(d1);
      const tm = Math.atan2(dot(d2, u), dot(d2, d1));
      const t2: V3 = add(mul(d1, Math.cos(tm)), mul(u, Math.sin(tm)));
      const u2: V3 = add(mul(d1, -Math.sin(tm)), mul(u, Math.cos(tm)));
      const ti = Math.atan2(dot(d3, u2), dot(d3, t2));
      out[f] = [alpha, beta, tm, ti];
      continue;
    }
    const mc = L[a];
    const mcAng = planeAngle(mc);
    // spread: the finger moves in one plane through n, so every segment's shadow on the palm plane lies along
    // the finger's direction (or straight back along it once curled past 90 degrees). Use the longest shadow;
    // when the finger points straight out of the palm there is none, and the spread fades to 0.
    let v: V3 = [0, 0, 0], inPlane = 0;
    for (const s of [d1, d2, d3, norm(sub(L[d], L[a]))]) {
      const l = Math.hypot(s[0], s[1]);
      if (l > inPlane) { inPlane = l; v = s; }
    }
    const mcDir: V3 = [Math.sin(mcAng), Math.cos(mcAng), 0];
    if (v[0] * mcDir[0] + v[1] * mcDir[1] < 0) v = mul(v, -1);
    const abd = inPlane > 1e-6 ? wrap(planeAngle(v) - mcAng) * smoothstep(0.15, 0.35, inPlane) : 0;
    const b2: V3 = [Math.sin(mcAng + abd), Math.cos(mcAng + abd), 0];
    const c1 = Math.atan2(d1[2], dot(d1, b2));
    const c2 = Math.atan2(d2[2], dot(d2, b2));
    const c3 = Math.atan2(d3[2], dot(d3, b2));
    out[f] = [abd, c1, wrap(c2 - c1), wrap(c3 - c2)];
  }
  return out;
}

/** The joints of one hand, palm-local, as the avatar builds them: base, segment lengths, metacarpal angle. */
export interface HandGeom {
  /** palm length: wrist to middle knuckle (metres) */
  palm: number;
  /** palm-local position of each finger's base joint (thumb CMC, finger MCP), and its 3 segment lengths */
  base: Record<Finger, V3>;
  lengths: Record<Finger, [number, number, number]>;
}

/** Geometry from 21 palm-local points (an avatar's rest joints, or a landmark hand). */
export function geomFromPoints(L: V3[]): HandGeom {
  const base = {} as Record<Finger, V3>, lengths = {} as Record<Finger, [number, number, number]>;
  for (const f of FINGERS) {
    const [a, b, c, d] = FINGER_LM[f];
    base[f] = L[a];
    lengths[f] = [len(sub(L[b], L[a])), len(sub(L[c], L[b])), len(sub(L[d], L[c]))];
  }
  return { palm: len(L[9]), base, lengths };
}

/** Forward kinematics: palm-local positions [base, j1, j2, tip] and segment directions of one finger. */
export function fk(g: HandGeom, f: Finger, q: number[]): { pts: V3[]; dirs: V3[] } {
  const [l1, l2, l3] = g.lengths[f];
  const p0 = g.base[f];
  let d1: V3, d2: V3, d3: V3;
  if (f === "thumb") {
    const [al, be, tm, ti] = q;
    d1 = [Math.cos(be) * Math.sin(al), Math.cos(be) * Math.cos(al), Math.sin(be)];
    const u = thumbPlane(d1);
    d2 = add(mul(d1, Math.cos(tm)), mul(u, Math.sin(tm)));
    const u2 = add(mul(d1, -Math.sin(tm)), mul(u, Math.cos(tm)));
    d3 = add(mul(d2, Math.cos(ti)), mul(u2, Math.sin(ti)));
  } else {
    const [ab, f1, f2, f3] = q;
    const ang = planeAngle(p0) + ab;
    const b: V3 = [Math.sin(ang), Math.cos(ang), 0];
    const n: V3 = [0, 0, 1];
    const dir = (t: number): V3 => add(mul(b, Math.cos(t)), mul(n, Math.sin(t)));
    d1 = dir(f1); d2 = dir(f1 + f2); d3 = dir(f1 + f2 + f3);
  }
  const p1 = add(p0, mul(d1, l1)), p2 = add(p1, mul(d2, l2)), p3 = add(p2, mul(d3, l3));
  return { pts: [p0, p1, p2, p3], dirs: [d1, d2, d3] };
}

export interface SolveOptions {
  /** IK: pull joints toward the landmark positions (scaled to the avatar's palm). 0 = angles only */
  ik?: number;
  /** IK: how hard the angles stay near the ones read from the landmarks (metres per radian) */
  stay?: number;
  /** finger thickness (radius, metres) for the no-intersection rule */
  radius?: number;
  iterations?: number;
}
const DEFAULTS: Required<SolveOptions> = { ik: 1, stay: 0.03, radius: 0.0065, iterations: 8 };

export type HandAngles = Record<Finger, number[]>;

/** clamp every joint into its range */
export function clampAngles(a: HandAngles): HandAngles {
  const out = {} as HandAngles;
  for (const f of FINGERS) out[f] = clampFinger(f, a[f]);
  return out;
}

/** Solve one finger: limits, then damped least squares toward the scaled landmark joints (projected onto the limits). */
function ikFinger(g: HandGeom, f: Finger, q0: number[], target: V3[], o: Required<SolveOptions>): number[] {
  let q = clampFinger(f, q0);
  if (!o.ik) return q;
  const wts = [0.5, 0.5, 1.0];
  const palmZ = 0.011 + o.radius; // palm half thickness + finger radius
  const residual = (qq: number[]): number[] => {
    const { pts } = fk(g, f, qq);
    const r: number[] = [];
    for (let j = 0; j < 3; j++) for (let d = 0; d < 3; d++) r.push(o.ik * wts[j] * (pts[j + 1][d] - target[j][d]));
    for (let k = 0; k < 4; k++) r.push(o.stay * (qq[k] - q0[k]));
    // fingertips and thumb joints may touch the palm, not go into it
    for (let j = 2; j <= 3; j++) {
      const p = pts[j];
      const inside = p[1] > 0.15 * g.palm && p[1] < 1.05 * g.palm && p[0] > g.base.pinky[0] - o.radius && p[0] < g.base.index[0] + o.radius && p[2] > -0.02;
      r.push(inside && p[2] < palmZ ? 3 * (palmZ - p[2]) : 0);
    }
    return r;
  };
  let mu = 1e-4;
  let r = residual(q);
  let cost = r.reduce((s, v) => s + v * v, 0);
  for (let it = 0; it < o.iterations; it++) {
    const J: number[][] = [];
    const h = 1e-5;
    for (let k = 0; k < 4; k++) {
      const qq = q.slice(); qq[k] += h;
      const rk = residual(qq);
      J.push(rk.map((v, i) => (v - r[i]) / h));
    }
    // (J^T J + mu I) dq = -J^T r
    const A = [0, 1, 2, 3].map((a) => [0, 1, 2, 3].map((b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0) + (a === b ? mu : 0)));
    const gvec = [0, 1, 2, 3].map((a) => -J[a].reduce((s, v, i) => s + v * r[i], 0));
    const dq = solve4(A, gvec);
    if (!dq) break;
    const qn = clampFinger(f, q.map((v, k) => v + dq[k]));
    const rn = residual(qn);
    const cn = rn.reduce((s, v) => s + v * v, 0);
    if (cn < cost) { q = qn; r = rn; cost = cn; mu *= 0.3; } else mu *= 10;
    if (Math.abs(dq.reduce((s, v) => s + Math.abs(v), 0)) < 1e-5) break;
  }
  return q;
}

function solve4(A: number[][], b: number[]): number[] | null {
  const n = 4, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let cc = c; cc <= n; cc++) M[r][cc] -= k * M[c][cc];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** closest distance between segments p1-q1 and p2-q2 */
export function segDist(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return len(r);
  if (a <= 1e-12) { t = clamp(f / e, 0, 1); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { s = clamp(-c / a, 0, 1); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return len(sub(add(p1, mul(d1, s)), add(p2, mul(d2, t))));
}

/** smallest gap between two fingers' capsules (negative = overlap), skipping each finger's first joint stub */
export function fingerGap(g: HandGeom, f1: Finger, q1: number[], f2: Finger, q2: number[], radius: number): number {
  const A = fk(g, f1, q1).pts, B = fk(g, f2, q2).pts;
  let m = Infinity;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m = Math.min(m, segDist(A[i], A[i + 1], B[j], B[j + 1]));
  return m - 2 * radius;
}

const NEIGHBOURS: [Finger, Finger][] = [["index", "middle"], ["middle", "ring"], ["ring", "pinky"]];

/**
 * Move neighbouring fingers out of each other, inside the (coupled) limits, until their capsules no longer
 * overlap. Each step tries small moves of the pair (spread apart or together, flex the pair toward each other's
 * curl, or the more curled finger a little further past the other) and keeps the one that opens the gap most,
 * without closing another gap. Returns the number of steps taken.
 */
export function separateFingers(g: HandGeom, a: HandAngles, radius: number): number {
  const minGap = (h: HandAngles) => Math.min(...NEIGHBOURS.map(([x, y]) => fingerGap(g, x, h[x], y, h[y], radius)));
  // never change the handshape by more than this per joint: an overlap left over beats a different sign
  const start = Object.fromEntries((["index", "middle", "ring", "pinky"] as Finger[]).map((f) => [f, a[f].slice()])) as HandAngles;
  const MAX = 12 * D;
  const within = (f: Finger, q: number[]) => q.every((v, k) => Math.abs(v - start[f][k]) <= MAX + 1e-9);
  let moved = 0;
  for (let it = 0; it < 40; it++) {
    let any = false;
    for (const [f1, f2] of NEIGHBOURS) {
      const gap = fingerGap(g, f1, a[f1], f2, a[f2], radius);
      if (gap >= -1e-4) continue;
      any = true;
      const s = 2 * D;
      const moves: [number[], number[]][] = [
        [[s, 0, 0, 0], [-s, 0, 0, 0]], [[-s, 0, 0, 0], [s, 0, 0, 0]],
        [[0, s, s, 0], [0, -s, -s, 0]], [[0, -s, -s, 0], [0, s, s, 0]],
        [[0, s, s, s], [0, 0, 0, 0]], [[0, 0, 0, 0], [0, s, s, s]],
      ];
      const before = minGap(a);
      let best: HandAngles | null = null, bestGap = gap;
      for (const [m1, m2] of moves) {
        const c: HandAngles = { ...a, [f1]: clampFinger(f1, a[f1].map((v, k) => v + m1[k])), [f2]: clampFinger(f2, a[f2].map((v, k) => v + m2[k])) };
        if (!within(f1, c[f1]) || !within(f2, c[f2])) continue;
        const gp = fingerGap(g, f1, c[f1], f2, c[f2], radius);
        if (gp > bestGap + 1e-6 && minGap(c) >= Math.min(before, gp) - 1e-6) { best = c; bestGap = gp; }
      }
      if (!best) continue;
      a[f1] = best[f1]; a[f2] = best[f2];
      moved++;
    }
    if (!any) break;
  }
  return moved;
}

/**
 * One hand, one frame: landmarks (any metric frame, MediaPipe order) -> limited, IK-fitted joint angles for an
 * avatar hand with geometry `g` (palm-local). `prev` (last frame's answer) warm-starts nothing yet but keeps
 * the call shape for streaming use.
 */
export function solveHand(points: V3[], side: Side, g: HandGeom, opts: SolveOptions = {}): { angles: HandAngles; frame: PalmFrame } | null {
  const o = { ...DEFAULTS, ...opts };
  const F = palmFrameRobust(points, side);
  if (!F) return null;
  const L = points.map((p) => toLocal(F, p));
  const raw = readAngles(L);
  const angles = {} as HandAngles;
  // IK targets: each finger's own joints relative to its base joint, scaled to the avatar finger's length,
  // so a straight finger stays straight whatever the avatar's knuckle layout
  const targetsOf = (f: Finger): V3[] => {
    const idx = FINGER_LM[f];
    const lmLen = len(sub(L[idx[1]], L[idx[0]])) + len(sub(L[idx[2]], L[idx[1]])) + len(sub(L[idx[3]], L[idx[2]]));
    const avLen = g.lengths[f][0] + g.lengths[f][1] + g.lengths[f][2];
    const s = avLen / (lmLen || 1);
    return [1, 2, 3].map((j) => add(g.base[f], mul(sub(L[idx[j]], L[idx[0]]), s)));
  };
  for (const f of FINGERS) if (f !== "thumb") angles[f] = ikFinger(g, f, raw[f], targetsOf(f), o);
  separateFingers(g, angles, o.radius);
  // thumb last: when its tip touches a fingertip in the landmarks (pinch: F, O, 9, ...), aim it at the avatar's
  // fingertip instead, so the contact survives the avatar's different proportions
  const tThumb = targetsOf("thumb");
  const palmScale = g.palm / (len(L[9]) || 1);
  let best: Finger | null = null, bestD = 0.3 * len(L[9]);
  for (const f of ["index", "middle"] as Finger[]) {
    const dd = len(sub(L[4], L[FINGER_LM[f][3]]));
    if (dd < bestD) { bestD = dd; best = f; }
  }
  if (best) {
    const tipAv = fk(g, best, angles[best]).pts[3];
    tThumb[2] = add(tipAv, mul(sub(L[4], L[FINGER_LM[best][3]]), palmScale));
  }
  angles.thumb = ikFinger(g, "thumb", raw.thumb, tThumb, o);
  return { angles, frame: F };
}

/** Joint-limit violations of a hand (21 points), counted over the 20 joint parameters. tolDeg: allowed slack. */
export function countViolations(points: V3[], side: Side, tolDeg = 1): { count: number; joints: string[] } {
  const F = palmFrame(points, side);
  if (!F) return { count: 0, joints: [] };
  const a = readAngles(points.map((p) => toLocal(F, p)));
  const joints: string[] = [];
  for (const f of FINGERS) a[f].forEach((v, k) => {
    const [lo, hi] = jointRange(f, k, a[f]);
    if (v < lo - tolDeg * D || v > hi + tolDeg * D) joints.push(`${f} ${JOINT_NAMES[f][k]} ${Math.round(v / D)}°`);
  });
  return { count: joints.length, joints };
}

/** Number of overlapping neighbour-finger pairs of 21 points (capsules of radius r, scaled to a 9 cm palm). */
export function countOverlaps(points: V3[], side: Side, radius = 0.0065): number {
  const F = palmFrame(points, side);
  if (!F) return 0;
  const L = points.map((p) => toLocal(F, p));
  const s = 0.09 / (len(L[9]) || 1);
  const P = L.map((p) => mul(p, s));
  let n = 0;
  for (const [f1, f2] of NEIGHBOURS) {
    const A = FINGER_LM[f1].map((i) => P[i]), B = FINGER_LM[f2].map((i) => P[i]);
    let m = Infinity;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m = Math.min(m, segDist(A[i], A[i + 1], B[j], B[j + 1]));
    if (m < 2 * radius - 1e-4) n++;
  }
  return n;
}

// ---------------------------------------------------------------- smoothing
/** One-euro filter (Casiez et al. 2012) on one scalar channel. */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  minCutoff: number; beta: number; dCutoff: number;
  constructor(minCutoff = 1.7, beta = 0.4, dCutoff = 1.0) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; }
  private static alpha(cutoff: number, dt: number) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  reset() { this.x = null; this.dx = 0; }
  filter(v: number, dt: number): number {
    if (this.x === null) { this.x = v; return v; }
    const d = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (d - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

/**
 * Smooth a sequence of hand angles. Offline (zeroPhase) runs the one-euro filter forward and then backward,
 * so nothing lags; streaming (zeroPhase=false) is causal. Null frames reset the filter (no smoothing across gaps).
 */
export function smoothSequence(seq: (HandAngles | null)[], fps: number, zeroPhase = true, minCutoff = 1.7, beta = 0.4): (HandAngles | null)[] {
  const dt = 1 / fps;
  const run = (src: (HandAngles | null)[], order: number[]) => {
    const out: (HandAngles | null)[] = src.map((a) => (a ? Object.fromEntries(FINGERS.map((f) => [f, a[f].slice()])) as HandAngles : null));
    const filt = FINGERS.map(() => [0, 1, 2, 3].map(() => new OneEuro(minCutoff, beta)));
    for (const i of order) {
      const a = out[i];
      if (!a) { filt.forEach((fs) => fs.forEach((x) => x.reset())); continue; }
      FINGERS.forEach((f, fi) => { for (let k = 0; k < 4; k++) a[f][k] = filt[fi][k].filter(a[f][k], dt); });
    }
    return out;
  };
  const idx = seq.map((_, i) => i);
  const fwd = run(seq, idx);
  if (!zeroPhase) return fwd;
  const back = run(fwd, idx.slice().reverse());
  // limits survive smoothing (averages of in-range values stay in range), clamp anyway against float drift
  return back.map((a) => (a ? clampAngles(a) : null));
}
