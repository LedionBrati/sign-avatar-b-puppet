// Clean a baked rotation track so the puppet moves smoothly without changing the signs.
//
// The puppet solves every motion frame into bone rotations once ("baking", src/vrm.ts). This file then
// works on those rotations per bone, over the WHOLE clip (we know the future, so nothing here lags):
//   1. glitches out: a run of <= 3 frames that leaves the path and comes back faster than a joint can move
//      (tracker flips, e.g. a hand read inside out for one frame) is replaced by the path between its neighbours;
//   2. dropouts bridged: a short tracking gap is filled with the path between the poses on either side; a long
//      gap or one at the clip edge eases from the last tracked pose to the fallback (rest) and back in again,
//      instead of snapping;
//   3. jitter out: a small zero-phase Gaussian (no lag, held poses stay exact) per bone.
// Playback then interpolates between the cleaned frames (sampleTrack), so the screen gets a new pose every
// refresh instead of every 1/24 s.
//
// Pure math on Float32Arrays (x, y, z, w per frame), no DOM, no VRM: unit-tested in test/track.test.ts.

import * as THREE from "three";

export interface ChannelParams {
  /** fastest plausible angular speed of this joint, degrees per second (glitch test) */
  maxSpeedDegS: number;
  /** zero-phase Gaussian smoothing, seconds (0 = off) */
  sigmaS: number;
}

export interface QuatChannel {
  name: string;
  /** n x [x, y, z, w]; at untracked frames it holds the fallback the solver used (rest pose) */
  q: Float32Array;
  /** 1 = tracked at this frame */
  valid: Uint8Array;
  params: ChannelParams;
}

export interface ScalarChannel {
  name: string;
  v: Float32Array;
  valid: Uint8Array;
}

export interface CleanOptions {
  /** gaps up to this long (seconds) between two tracked stretches are bridged */
  maxFillS: number;
  /** longer gaps and clip edges ease between tracked pose and fallback over this long (seconds) */
  fadeS: number;
  /** longest glitch run, frames */
  spikeMaxFrames: number;
  /** slack on the glitch test, degrees */
  spikeTolDeg: number;
}

export const DEFAULT_CLEAN: CleanOptions = { maxFillS: 0.5, fadeS: 0.25, spikeMaxFrames: 3, spikeTolDeg: 10 };

export interface CleanStats {
  /** frames replaced as glitches */
  spikeFrames: number;
  /** untracked frames bridged between two tracked poses */
  bridgedFrames: number;
  /** untracked frames eased between a tracked pose and the fallback */
  fadedFrames: number;
}

const _a = new THREE.Quaternion();
const _b = new THREE.Quaternion();

/** smoothstep 0..1 */
export const ease = (w: number): number => (w <= 0 ? 0 : w >= 1 ? 1 : w * w * (3 - 2 * w));

const dot4 = (q: ArrayLike<number>, i: number, r: ArrayLike<number>, j: number) =>
  q[4 * i] * r[4 * j] + q[4 * i + 1] * r[4 * j + 1] + q[4 * i + 2] * r[4 * j + 2] + q[4 * i + 3] * r[4 * j + 3];

/** angle (degrees) between rotations i and j of q */
export function angleDeg4(q: ArrayLike<number>, i: number, j: number, r: ArrayLike<number> = q): number {
  return (2 * Math.acos(Math.min(1, Math.abs(dot4(q, i, r, j)))) * 180) / Math.PI;
}

/** write slerp(src[i], src[j], w) into dst[k] (shortest path) */
export function slerpInto(dst: Float32Array, k: number, src: ArrayLike<number>, i: number, j: number, w: number): void {
  _a.fromArray(src as number[], 4 * i);
  _b.fromArray(src as number[], 4 * j);
  _a.slerp(_b, w).toArray(dst as unknown as number[], 4 * k);
}

/** flip signs so neighbouring frames sit in the same hemisphere (q and -q are the same rotation) */
export function alignHemispheres(q: Float32Array, n: number): void {
  for (let i = 1; i < n; i++) if (dot4(q, i - 1, q, i) < 0) for (let d = 0; d < 4; d++) q[4 * i + d] = -q[4 * i + d];
}

/**
 * Find glitches: runs of 1..maxRun tracked frames, between two tracked neighbours, whose rotation leaves the
 * path between those neighbours by more than the joint could travel out and back in that time.
 * Returns a mask of the glitch frames (q is not changed; see bridgeRuns).
 */
export function findSpikes(q: Float32Array, valid: Uint8Array, n: number, fps: number, maxSpeedDegS: number, maxRun = 3, tolDeg = 10): Uint8Array {
  const perFrame = maxSpeedDegS / fps;
  const ref = new Float32Array(4);
  const mask = new Uint8Array(n);
  for (let L = 1; L <= maxRun; L++) {
    for (let i = 1; i + L < n; i++) {
      const a = i - 1, b = i + L;
      if (!valid[a] || !valid[b]) continue;
      // shortest explanation first: frames (and anchors) already marked by a shorter run are not reused
      if (mask[a] || mask[b]) continue;
      let ok = true;
      for (let j = i; j < b; j++) if (!valid[j] || mask[j]) { ok = false; break; }
      if (!ok) continue;
      let tooFast = false, maxDev = 0;
      for (let j = i; j < b; j++) {
        slerpInto(ref, 0, q, a, b, (j - a) / (b - a));
        const dev = angleDeg4(q, j, 0, ref);
        maxDev = Math.max(maxDev, dev);
        if (dev > perFrame * Math.min(j - a, b - j) + tolDeg) tooFast = true;
      }
      // out AND back: the anchors must sit close together compared with the excursion. Otherwise this is a
      // real move (or one anchor is itself the glitch, which is then found as its own run).
      if (!tooFast || angleDeg4(q, a, b) > maxDev / 2) continue;
      for (let j = i; j < b; j++) mask[j] = 1;
    }
  }
  return mask;
}

/**
 * Replace every run of masked frames with the path between the unmasked frames on either side.
 * The caller guarantees those neighbours exist and are tracked (findSpikes masks are always bounded by
 * tracked anchors; so is a union of masks from bones that share their tracking). Returns frames replaced.
 */
export function bridgeRuns(q: Float32Array, mask: Uint8Array, n: number): number {
  let replaced = 0;
  for (let i = 0; i < n; ) {
    if (!mask[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && mask[j + 1]) j++;
    const a = i - 1, b = j + 1;
    if (a >= 0 && b < n) {
      for (let k = i; k <= j; k++) slerpInto(q, k, q, a, b, (k - a) / (b - a));
      replaced += j - i + 1;
    }
    i = j + 1;
  }
  return replaced;
}

/** findSpikes + bridgeRuns on one bone. Returns frames replaced. */
export function removeSpikes(q: Float32Array, valid: Uint8Array, n: number, fps: number, maxSpeedDegS: number, maxRun = 3, tolDeg = 10): number {
  return bridgeRuns(q, findSpikes(q, valid, n, fps, maxSpeedDegS, maxRun, tolDeg), n);
}

export interface ChainRule {
  /** the first `parents` channels are parents of the rest: a glitch there is a glitch of the whole chain */
  parents: number;
  /** this many channels glitching on the same frame is also a glitch of the whole chain */
  minVotes: number;
}

/**
 * Glitch frames for a chain of bones that move as one, parents first (e.g. forearm roll, wrist, then fingers).
 * Each bone gets its own glitches, plus the chain's: frames where a parent glitches or where many bones glitch
 * together (a hand read inside out shows up in most fingers at once, a single bad finger in one or two).
 * Repairing the whole chain there keeps it consistent: repaired fingers on an unrepaired, flipped wrist
 * would point the wrong way. All channels must share the same tracking (valid) mask.
 */
export function linkedSpikes(chs: QuatChannel[], n: number, fps: number, rule: ChainRule, opts: CleanOptions = DEFAULT_CLEAN): Uint8Array[] {
  const own = chs.map((ch) => {
    alignHemispheres(ch.q, n);
    return findSpikes(ch.q, ch.valid, n, fps, ch.params.maxSpeedDegS, opts.spikeMaxFrames, opts.spikeTolDeg);
  });
  const chain = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let votes = 0, parent = false;
    own.forEach((m, k) => { if (m[i]) { votes++; if (k < rule.parents) parent = true; } });
    chain[i] = parent || votes >= rule.minVotes ? 1 : 0;
  }
  return own.map((m) => m.map((v, i) => v | chain[i]));
}

/** untracked runs [start, end] (inclusive) */
function gaps(valid: Uint8Array, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; ) {
    if (valid[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && !valid[j + 1]) j++;
    out.push([i, j]);
    i = j + 1;
  }
  return out;
}

function fillFrames(fps: number, opts: CleanOptions): { maxFill: number; fade: number } {
  const fade = Math.max(1, Math.round(opts.fadeS * fps));
  return { fade, maxFill: Math.max(2 * fade, Math.round(opts.maxFillS * fps)) };
}

/**
 * Fill untracked frames in place. Between two tracked frames and no longer than maxFill: the path between them.
 * Otherwise: the fallback already stored at that frame, eased toward the last tracked pose just after it is lost
 * and toward the next tracked pose just before it comes back (fade frames each side; maxFill >= 2 x fade,
 * so the two never overlap).
 */
export function fillQuatGaps(q: Float32Array, valid: Uint8Array, n: number, fps: number, opts: CleanOptions = DEFAULT_CLEAN): Pick<CleanStats, "bridgedFrames" | "fadedFrames"> {
  const { maxFill, fade } = fillFrames(fps, opts);
  let bridged = 0, faded = 0;
  for (const [g0, g1] of gaps(valid, n)) {
    const L = g0 - 1, R = g1 + 1;
    const hasL = L >= 0, hasR = R < n;
    if (hasL && hasR && g1 - g0 + 1 <= maxFill) {
      for (let i = g0; i <= g1; i++) slerpInto(q, i, q, L, R, (i - L) / (R - L));
      bridged += g1 - g0 + 1;
      continue;
    }
    for (let i = g0; i <= g1; i++) {
      let touched = false;
      if (hasL && i - L <= fade) { slerpInto(q, i, q, i, L, 1 - ease((i - L) / (fade + 1))); touched = true; }
      if (hasR && R - i <= fade) { slerpInto(q, i, q, i, R, 1 - ease((R - i) / (fade + 1))); touched = true; }
      if (touched) faded++;
    }
  }
  return { bridgedFrames: bridged, fadedFrames: faded };
}

/** Same as fillQuatGaps for a scalar (expression weights): linear bridge, eased fade to the stored fallback. */
export function fillScalarGaps(v: Float32Array, valid: Uint8Array, n: number, fps: number, opts: CleanOptions = DEFAULT_CLEAN): Pick<CleanStats, "bridgedFrames" | "fadedFrames"> {
  const { maxFill, fade } = fillFrames(fps, opts);
  let bridged = 0, faded = 0;
  for (const [g0, g1] of gaps(valid, n)) {
    const L = g0 - 1, R = g1 + 1;
    const hasL = L >= 0, hasR = R < n;
    if (hasL && hasR && g1 - g0 + 1 <= maxFill) {
      for (let i = g0; i <= g1; i++) v[i] = v[L] + (v[R] - v[L]) * ((i - L) / (R - L));
      bridged += g1 - g0 + 1;
      continue;
    }
    for (let i = g0; i <= g1; i++) {
      let touched = false;
      if (hasL && i - L <= fade) { const w = 1 - ease((i - L) / (fade + 1)); v[i] += (v[L] - v[i]) * w; touched = true; }
      if (hasR && R - i <= fade) { const w = 1 - ease((R - i) / (fade + 1)); v[i] += (v[R] - v[i]) * w; touched = true; }
      if (touched) faded++;
    }
  }
  return { bridgedFrames: bridged, fadedFrames: faded };
}

/**
 * Zero-phase Gaussian smoothing of a rotation track (weighted average of neighbouring quaternions, renormalised).
 * Symmetric kernel: no lag, a constant rotation stays exact, a held pose stays exact once it is held for a few frames.
 */
export function smoothQuats(q: Float32Array, n: number, fps: number, sigmaS: number): void {
  const sigma = sigmaS * fps; // frames
  if (!(sigma > 0.05) || n < 3) return;
  const R = Math.max(1, Math.ceil(3 * sigma));
  const w = Array.from({ length: R + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sigma * sigma)));
  const src = q.slice(0, 4 * n);
  for (let i = 0; i < n; i++) {
    // near the clip edges shrink the window on BOTH sides, so it stays symmetric (no lag, no pull at the ends)
    const r = Math.min(R, i, n - 1 - i);
    let x = 0, y = 0, z = 0, s = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      const sign = dot4(src, i, src, j) < 0 ? -1 : 1;
      const wk = w[Math.abs(k)] * sign;
      x += src[4 * j] * wk; y += src[4 * j + 1] * wk; z += src[4 * j + 2] * wk; s += src[4 * j + 3] * wk;
    }
    const len = Math.hypot(x, y, z, s);
    if (len < 1e-9) continue; // cannot happen for neighbours closer than 180 deg; keep the frame as is
    q[4 * i] = x / len; q[4 * i + 1] = y / len; q[4 * i + 2] = z / len; q[4 * i + 3] = s / len;
  }
}

/**
 * The whole clean-up for one bone, in place. `spikes`: glitch frames shared with a linked chain
 * (linkedSpikes); without it the bone's own glitches are used.
 */
export function cleanQuatChannel(ch: QuatChannel, n: number, fps: number, opts: CleanOptions = DEFAULT_CLEAN, spikes?: Uint8Array): CleanStats {
  alignHemispheres(ch.q, n);
  const mask = spikes ?? findSpikes(ch.q, ch.valid, n, fps, ch.params.maxSpeedDegS, opts.spikeMaxFrames, opts.spikeTolDeg);
  const spikeFrames = bridgeRuns(ch.q, mask, n);
  const fill = fillQuatGaps(ch.q, ch.valid, n, fps, opts);
  alignHemispheres(ch.q, n);
  smoothQuats(ch.q, n, fps, ch.params.sigmaS);
  alignHemispheres(ch.q, n);
  return { spikeFrames, ...fill };
}

/** Expression weights: gaps only (blinks are fast on purpose, so no glitch test and no smoothing). */
export function cleanScalarChannel(ch: ScalarChannel, n: number, fps: number, opts: CleanOptions = DEFAULT_CLEAN): CleanStats {
  return { spikeFrames: 0, ...fillScalarGaps(ch.v, ch.valid, n, fps, opts) };
}

/** Frame position for playback: integer frame k and weight w toward k + 1 (clamped to the clip). */
export function framePos(n: number, frame: number): { k: number; w: number } {
  if (!(frame > 0)) return { k: 0, w: 0 };
  if (frame >= n - 1) return { k: n - 1, w: 0 };
  const k = Math.floor(frame);
  return { k, w: frame - k };
}

/** Twist part of q about a unit axis (swing-twist decomposition, q = swing * twist). Identity if undefined. */
export function twistAbout(q: THREE.Quaternion, axis: THREE.Vector3): THREE.Quaternion {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const t = new THREE.Quaternion(axis.x * d, axis.y * d, axis.z * d, q.w);
  return t.lengthSq() < 1e-12 ? new THREE.Quaternion() : t.normalize();
}
