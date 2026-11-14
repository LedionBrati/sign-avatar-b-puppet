// Motion file format v1 (motion/FORMAT.md): types, validation, loading, frame lookup.

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export interface MotionFrame {
  i: number;
  t: number;
  /** 33 x [x, y, z, visibility], image coords 0..1, y down */
  pose: Vec4[] | null;
  /** 33 x [x, y, z] metres, origin between the hips, y down */
  poseWorld: Vec3[] | null;
  /** 478 x [x, y, z] image coords (468 mesh + 10 iris) */
  face: Vec3[] | null;
  faceBlendshapes?: Record<string, number> | null;
  /** 21 x [x, y, z] image coords, the SUBJECT's left hand */
  leftHand: Vec3[] | null;
  leftHandWorld?: Vec3[] | null;
  /** 21 x [x, y, z] image coords, the SUBJECT's right hand */
  rightHand: Vec3[] | null;
  rightHandWorld?: Vec3[] | null;
}

export interface MotionSource {
  file: string | null;
  dataset?: string | null;
  license?: string | null;
  signer?: string | null;
  start_s?: number | null;
  end_s?: number | null;
}

export interface Motion {
  version: 1;
  name: string;
  /** canonical catalog ID (catalog/signs.json), e.g. "HELLO"; null for a sentence clip. Optional. */
  motion_id?: string | null;
  gloss: string | null;
  source: MotionSource;
  fps: number;
  width: number;
  height: number;
  dominant_hand: "right" | "left" | null;
  mirrored: boolean;
  extractor?: { name?: string; version?: string; model?: string | null } | null;
  cleaned: boolean;
  cleanup?: unknown;
  frames: MotionFrame[];
}

export type Part = "pose" | "poseWorld" | "face" | "leftHand" | "rightHand" | "leftHandWorld" | "rightHandWorld";

const SIZES: Record<Part, [count: number, dims: number]> = {
  pose: [33, 4],
  poseWorld: [33, 3],
  face: [478, 3],
  leftHand: [21, 3],
  rightHand: [21, 3],
  leftHandWorld: [21, 3],
  rightHandWorld: [21, 3],
};

export class MotionError extends Error {
  constructor(public problems: string[]) {
    super(`invalid motion file:\n  - ${problems.slice(0, 20).join("\n  - ")}${problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : ""}`);
  }
}

function checkPoints(v: unknown, part: Part, where: string, problems: string[], warnings: string[]): void {
  if (v === null || v === undefined) return; // missing parts are null (FORMAT.md rule)
  const [count, dims] = SIZES[part];
  if (!Array.isArray(v)) { problems.push(`${where}.${part}: expected array or null`); return; }
  // tolerate a 468-point face (no iris) with a warning
  if (part === "face" && v.length === 468) warnings.push(`${where}.face has 468 points (no iris)`);
  else if (v.length !== count) { problems.push(`${where}.${part}: expected ${count} points, got ${v.length}`); return; }
  for (let k = 0; k < v.length; k++) {
    const p = v[k];
    // pose without visibility is tolerated
    if (!Array.isArray(p) || (p.length !== dims && !(part === "pose" && p.length === 3))) {
      problems.push(`${where}.${part}[${k}]: expected ${dims} numbers`); return;
    }
    for (const n of p) if (typeof n !== "number" || !Number.isFinite(n)) { problems.push(`${where}.${part}[${k}]: non-finite number`); return; }
  }
}

/** Validate an unknown JSON value against FORMAT.md v1. Throws MotionError listing every problem. */
export function validateMotion(x: unknown): { motion: Motion; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (typeof x !== "object" || x === null) throw new MotionError(["not an object"]);
  const m = x as Record<string, unknown>;
  if (m.version !== 1) problems.push(`version: expected 1, got ${JSON.stringify(m.version)}`);
  if (m.motion_id !== undefined && m.motion_id !== null && typeof m.motion_id !== "string") problems.push("motion_id: expected a string or null");
  if (typeof m.fps !== "number" || !(m.fps > 0)) problems.push("fps: expected a positive number");
  if (typeof m.width !== "number" || !(m.width > 0)) problems.push("width: expected a positive number");
  if (typeof m.height !== "number" || !(m.height > 0)) problems.push("height: expected a positive number");
  if (m.dominant_hand !== undefined && m.dominant_hand !== null && m.dominant_hand !== "left" && m.dominant_hand !== "right")
    problems.push(`dominant_hand: expected "left", "right" or null`);
  if (!Array.isArray(m.frames) || m.frames.length === 0) problems.push("frames: expected a non-empty array");
  else {
    let prevT = -Infinity;
    m.frames.forEach((f: any, k: number) => {
      const where = `frames[${k}]`;
      if (typeof f !== "object" || f === null) { problems.push(`${where}: not an object`); return; }
      if (typeof f.t !== "number" || !Number.isFinite(f.t)) problems.push(`${where}.t: expected a number`);
      else { if (f.t < prevT) problems.push(`${where}.t: time goes backwards`); prevT = f.t; }
      if (f.i !== undefined && f.i !== k) warnings.push(`${where}.i is ${f.i}, expected ${k}`);
      for (const part of Object.keys(SIZES) as Part[]) checkPoints(f[part], part, where, problems, warnings);
    });
  }
  if (problems.length) throw new MotionError(problems);
  // normalise optional fields so the rest of the code can rely on them
  const motion = x as Motion;
  motion.name ??= "untitled";
  motion.motion_id ??= null;
  motion.gloss ??= null;
  motion.source ??= { file: null };
  motion.dominant_hand ??= null;
  motion.mirrored ??= false;
  motion.cleaned ??= false;
  motion.frames.forEach((f, k) => {
    f.i = k;
    f.pose ??= null; f.poseWorld ??= null; f.face ??= null; f.leftHand ??= null; f.rightHand ??= null;
  });
  return { motion, warnings };
}

export async function loadMotion(url: string): Promise<{ motion: Motion; warnings: string[] }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load motion ${url}: HTTP ${res.status}`);
  return validateMotion(await res.json());
}

export function duration(m: Motion): number {
  const last = m.frames[m.frames.length - 1];
  return last.t + 1 / m.fps;
}

/** Index of the frame that is showing at time t (seconds from the start of the file): the last frame with frame.t <= t. */
export function frameIndexAt(m: Motion, t: number): number {
  const f = m.frames;
  if (t <= f[0].t) return 0;
  if (t >= f[f.length - 1].t) return f.length - 1;
  let lo = 0, hi = f.length - 1; // binary search: f[lo].t <= t < f[hi].t
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f[mid].t <= t + 1e-9) lo = mid; else hi = mid;
  }
  return lo;
}

export function frameAt(m: Motion, t: number): MotionFrame {
  return m.frames[frameIndexAt(m, t)];
}

/** How many frames have each part missing: a quick tracking-quality summary. */
export function missingStats(m: Motion): Record<"pose" | "face" | "leftHand" | "rightHand", number> {
  const s = { pose: 0, face: 0, leftHand: 0, rightHand: 0 };
  for (const f of m.frames) {
    if (!f.pose) s.pose++;
    if (!f.face) s.face++;
    if (!f.leftHand) s.leftHand++;
    if (!f.rightHand) s.rightHand++;
  }
  return s;
}
