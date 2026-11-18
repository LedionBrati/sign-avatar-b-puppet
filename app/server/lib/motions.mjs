// Motion library for the instant 3D signer (puppet/src/player.ts in the browser): which signs have extracted motion,
// and the slim motion files the player needs, served at GET /motion/<stem>.json.
//
//   MOTION_DIRS     v1 motion dirs (<stem>.clean.json + summary.csv QC), the same setting generate-on-use reads.
//                   Default <repo>/out/motion/wlasl.
//   MOTION_V2_DIRS  v2 dirs, searched recursively for <stem>.v2.json (motion/FORMAT.md v2, WiLoR hands). A v2 file
//                   wins over the v1 file of the same sign. Default <repo>/out/motion/wlasl3d.
//   MOTION_REST     the rest pose every 3D phrase starts and ends in. Default out/realtime/neutral.clean.json.
//   MOTION=off      no 3D signer (the server answers as before: clips only).
//
// motion_id / gloss come from each file's head (the same index generate-on-use uses, lib/ondemand.mjs). Signs that
// failed extraction or QC (dominant hand in < MOTION_MIN_HAND_PCT % of frames, default 80) are left out.
//
// Slim files: the player uses 9 of the 478 face points (head turn + hand placement near the face, puppet/src/vrm.ts
// solveHead, puppet/src/place.ts sourceAnchors) and 15 of the 51 blendshapes (expressions). The rest of the face is
// ~70 % of a file, so it is dropped: the frame keeps `face` = those 9 points and the file says which ones in
// `face_subset`; app/core inflateMotion() puts them back at their MediaPipe indices before the player validates it.
// Only done when every frame that has a face also has blendshapes (else the player solves the face from the mesh).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { displayGloss, scanMotionDirs } from "./ondemand.mjs";
import { fromRepo, list, readMotionHead as readHead } from "./paths.mjs";

/** MediaPipe face indices the player reads: nose tip, forehead, eye corners, chin, face outline at the ears. */
export const FACE_KEEP = Object.freeze([1, 10, 33, 133, 152, 234, 263, 362, 454]);
/** ARKit blendshapes the player reads (puppet/src/vrm.ts solveExpressions). */
export const BLENDSHAPES_KEEP = Object.freeze(["eyeBlinkLeft", "eyeBlinkRight", "jawOpen", "mouthFunnel", "mouthPucker",
  "mouthStretchLeft", "mouthStretchRight", "mouthSmileLeft", "mouthSmileRight", "browInnerUp", "browOuterUpLeft",
  "browOuterUpRight", "browDownLeft", "browDownRight"]);
const STEM = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;
const LETTER = /^FS_([A-Z])$/;
export const REST_STEM = "neutral";

const ifExists = (p) => (existsSync(p) ? p : null);

/** Settings from the environment (null = 3D signer off). Never under node --test unless passed explicitly. */
export function motionConfig(env = process.env) {
  if (/^(off|0|false|no)$/i.test(env.MOTION ?? "")) return null;
  if (env.NODE_TEST_CONTEXT && env.MOTION_IN_TESTS !== "1") return null;
  const v1 = list(env.MOTION_DIRS);
  const v2 = list(env.MOTION_V2_DIRS);
  return {
    dirs: v1.length ? v1 : [fromRepo("out/motion/wlasl")],
    v2Dirs: v2.length ? v2 : [fromRepo("out/motion/wlasl3d")],
    rest: env.MOTION_REST || ifExists(fromRepo("out/realtime/neutral.clean.json")),
    model: env.SIGNER_MODEL || ifExists(fromRepo("puppet/models/signer.glb")),
    minHandPct: Number.isFinite(Number(env.MOTION_MIN_HAND_PCT)) && env.MOTION_MIN_HAND_PCT ? Number(env.MOTION_MIN_HAND_PCT) : 80,
  };
}

/** Every <stem>.v2.json under dir (recursive). */
function findV2(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findV2(p, out);
    else if (e.isFile() && e.name.endsWith(".v2.json")) out.push(p);
  }
  return out;
}

/**
 * The motion library. signs: motion_id -> {motion_id, gloss, stem, url, v2, duration_s}; letters: "A" -> same (FS_A);
 * files: stem -> path (v2 preferred). Missing dirs are fine (an empty library).
 * @param {{dirs: string[], v2Dirs?: string[], rest?: string|null, model?: string|null, minHandPct?: number}} cfg
 */
export function createMotionLibrary(cfg) {
  const signs = new Map(), letters = new Map(), files = new Map(), heads = new Map();
  const v1 = scanMotionDirs(cfg.dirs ?? [], { minHandPct: cfg.minHandPct ?? 80, heads });
  // Letter motions (FS_A ...) are skipped by scanMotionDirs (it indexes signs); pick them up here.
  for (const dir of cfg.dirs ?? []) {
    let names = [];
    try { names = readdirSync(dir).filter((f) => f.endsWith(".clean.json")); } catch { continue; }
    for (const f of names) {
      const p = join(dir, f);
      const id = (heads.get(p) ?? readHead(p))?.motion_id;
      const l = id && LETTER.exec(id)?.[1];
      if (l && !letters.has(l)) letters.set(l, { path: p, id });
    }
  }
  const v2 = new Map();
  for (const dir of cfg.v2Dirs ?? []) {
    for (const p of findV2(dir)) {
      const h = readHead(p);
      if (h?.motion_id && !v2.has(h.motion_id)) v2.set(h.motion_id, { path: p, gloss: h.gloss });
    }
  }
  const add = (target, key, motion_id, gloss, path, isV2, seconds) => {
    const stem = basename(path).replace(/\.(v2|clean)\.json$/, "");
    if (!STEM.test(stem) || stem === REST_STEM || (files.has(stem) && files.get(stem) !== path)) return;
    files.set(stem, path);
    target.set(key, { motion_id, gloss, stem, url: `/motion/${encodeURIComponent(stem)}.json`, v2: isV2,
      duration_s: Math.round((seconds ?? 1.5) * 1000) / 1000 });
  };
  for (const [id, m] of v1) { const w = v2.get(id); add(signs, id, id, m.gloss, w?.path ?? m.path, Boolean(w), m.seconds); }
  // v2 signs with no (passing) v1 file still count: WiLoR re-extraction is the better motion.
  for (const [id, w] of v2) if (!signs.has(id) && !LETTER.test(id) && w.gloss) add(signs, id, id, displayGloss(w.gloss), w.path, true, null);
  for (const [l, x] of letters) { const w = v2.get(x.id); add(letters, l, x.id, l, w?.path ?? x.path, Boolean(w), 0.6); }
  const rest = cfg.rest && existsSync(cfg.rest) ? cfg.rest : null;
  if (rest) files.set(REST_STEM, rest);
  const model = cfg.model && existsSync(cfg.model) ? cfg.model : null;

  const cache = new Map();   // stem -> {mtime, json: Buffer, gz: Buffer, etag}; small LRU
  const MAX_CACHE = 64;
  /** The slim file for a stem, as JSON bytes + gzip, or null. Throws on a broken file. */
  function get(stem) {
    const path = files.get(stem);
    if (!path) return null;
    const st = statSync(path);
    const hit = cache.get(stem);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) { cache.delete(stem); cache.set(stem, hit); return hit; }
    const slim = slimMotion(JSON.parse(readFileSync(path, "utf8")));
    const json = Buffer.from(JSON.stringify(slim));
    // The real length, now that the file has been read (the index only has an estimate for files without QC rows).
    const seconds = slim.frames.length && slim.fps > 0 ? Math.round((slim.frames.length / slim.fps) * 1000) / 1000 : null;
    if (seconds) for (const map of [signs, letters]) for (const e of map.values()) if (e.stem === stem) e.duration_s = seconds;
    const entry = { mtime: st.mtimeMs, size: st.size, json, gz: gzipSync(json, { level: 6 }), etag: `"m${json.length.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`, mtimeDate: st.mtime };
    cache.set(stem, entry);
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return entry;
  }

  return {
    signs, letters, files, model, rest: rest ? `/motion/${REST_STEM}.json` : null,
    size: signs.size,
    /** [{motion_id, gloss}] for the translator. */
    vocab: () => [...signs.values()].map(({ motion_id, gloss }) => ({ motion_id, gloss })),
    get,
  };
}

/** Drop what the player never reads (see the header). Pure; returns a new object. */
export function slimMotion(m) {
  const frames = Array.isArray(m?.frames) ? m.frames : [];
  const faceOk = frames.every((f) => !f?.face || (f.faceBlendshapes && Object.keys(f.faceBlendshapes).length));
  const out = { version: m.version, name: m.name, motion_id: m.motion_id ?? null, gloss: m.gloss ?? null,
    source: { file: m.source?.file ?? null, dataset: m.source?.dataset ?? null, license: m.source?.license ?? null },
    fps: m.fps, width: m.width, height: m.height, dominant_hand: m.dominant_hand ?? null, mirrored: Boolean(m.mirrored), cleaned: Boolean(m.cleaned),
    ...(faceOk ? { face_subset: FACE_KEEP } : {}) };
  out.frames = frames.map((f) => {
    const g = { t: f.t, pose: f.pose ?? null, poseWorld: f.poseWorld ?? null,
      face: !f.face ? null : faceOk ? FACE_KEEP.map((k) => f.face[k] ?? f.face[1]) : f.face };
    if (f.faceBlendshapes) g.faceBlendshapes = faceOk ? Object.fromEntries(BLENDSHAPES_KEEP.filter((k) => k in f.faceBlendshapes).map((k) => [k, f.faceBlendshapes[k]])) : f.faceBlendshapes;
    g.leftHand = f.leftHand ?? null;
    if (f.leftHandWorld !== undefined) g.leftHandWorld = f.leftHandWorld;
    g.rightHand = f.rightHand ?? null;
    if (f.rightHandWorld !== undefined) g.rightHandWorld = f.rightHandWorld;
    if (f.hands3d) g.hands3d = { left: slimHand(f.hands3d.left), right: slimHand(f.hands3d.right) };
    return g;
  });
  return out;
}

const slimHand = (h) => (h ? { joints: h.joints, ...(h.rot ? { rot: h.rot } : {}), conf: h.conf ?? 0, ...(h.src ? { src: h.src } : {}) } : null);
