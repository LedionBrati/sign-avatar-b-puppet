// Generate puppet/fixtures/wave.json: a synthetic motion file (motion/FORMAT.md v1)
// so the puppet can be built and tested before real MediaPipe data exists.
//
// What it contains (3 s at 24 fps, 540x720, subject facing the camera):
//   0.0-1.0 s  the subject's RIGHT arm rises into signing space (appears on the IMAGE LEFT)
//   1.0-2.0 s  the right forearm waves side to side, palm toward the camera
//   1.6-2.6 s  the right fingers curl into a fist and open again (thumb folds too)
//   the LEFT arm hangs at rest; the left hand is "lost" (null) for frames 30-40
//   blinks at 0.5 s and 2.2 s, mouth opens around 1.5 s
//
// The face mesh is MediaPipe's canonical face model (Apache 2.0), fetched at run time.
// Usage: node scripts/make-fixture.mjs [--out fixtures/wave.json]

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outIdx = process.argv.indexOf("--out");
const out = resolve(outIdx > -1 ? process.argv[outIdx + 1] : resolve(here, "../fixtures/wave.json"));

const FPS = 24, SECONDS = 3, W = 540, H = 720;
const K = 800;          // pixels per metre in the image
const HIP_PX = 780;     // hip centre y in pixels (below the frame: waist-up framing)
const CX = W / 2;

// ---- small vector helpers (world coords: metres, x = image right = subject's LEFT, y down, z away from camera)
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const rot = (v, axis, ang) => { // Rodrigues
  const k = norm(axis), c = Math.cos(ang), s = Math.sin(ang);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
};
const toImg = (p) => [r4((CX + p[0] * K) / W), r4((HIP_PX + p[1] * K) / H), r4((p[2] * K) / W)];

// ---- hand model: 21 MediaPipe points from wrist position, finger axis u, palm normal n, curl 0..1
// Right hand: lateral (thumb side) axis l = u x n. Left hand: l = n x u.
function hand(wrist, u, n, side, curl, thumbCurl) {
  u = norm(u); n = norm(sub(n, mul(u, dot(n, u))));
  const l = side === "right" ? cross(u, n) : cross(n, u);
  const pts = new Array(21);
  pts[0] = wrist;
  const fingers = [ // [first index, lateral offset, base distance, segment lengths]
    [5, 0.026, 0.09, [0.042, 0.025, 0.021]],
    [9, 0.006, 0.093, [0.046, 0.028, 0.022]],
    [13, -0.013, 0.088, [0.043, 0.027, 0.021]],
    [17, -0.03, 0.08, [0.034, 0.02, 0.019]],
  ];
  const ang = curl * 1.45;
  for (const [i0, off, base, segs] of fingers) {
    let p = add(add(wrist, mul(l, off)), mul(u, base));
    pts[i0] = p;
    let d = u;
    for (let s = 0; s < 3; s++) {
      d = rot(d, l, side === "right" ? ang : -ang); // fold toward the palm (+n): l x u = n (right), -n (left)
      p = add(p, mul(d, segs[s]));
      pts[i0 + s + 1] = p;
    }
  }
  // thumb: CMC near the wrist on the thumb side, pointing out between u and l, folds across the palm
  let p = add(add(wrist, mul(l, 0.022)), mul(u, 0.025));
  pts[1] = p;
  let d = norm(add(mul(u, 0.75), mul(l, 0.66)));
  const tAng = thumbCurl * 0.9;
  const segs = [0.035, 0.03, 0.025];
  for (let s = 0; s < 3; s++) {
    d = norm(add(mul(rot(d, u, side === "right" ? -tAng * 0.6 : tAng * 0.6), 1), mul(n, Math.sin(tAng) * 0.35)));
    p = add(p, mul(d, segs[s]));
    pts[2 + s] = p;
  }
  return pts;
}

// sanity check of the fold direction: tips of a curled hand must sit on the palm side (+n)
{
  const h = hand([0, 0, 0], [0, -1, 0], [0, 0, -1], "right", 1, 1);
  const tipN = dot(sub(h[8], h[0]), [0, 0, -1]);
  const hl = hand([0, 0, 0], [0, -1, 0], [0, 0, -1], "left", 1, 1);
  const tipNl = dot(sub(hl[8], hl[0]), [0, 0, -1]);
  if (!(tipN > 0 && tipNl > 0)) throw new Error(`finger fold direction wrong: ${tipN} ${tipNl}`);
}

async function loadFace() {
  const url = "https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/modules/face_geometry/data/canonical_face_model.obj";
  try {
    const txt = await (await fetch(url)).text();
    const v = txt.split("\n").filter((l) => l.startsWith("v ")).map((l) => l.trim().split(/\s+/).slice(1, 4).map(Number));
    if (v.length !== 468) throw new Error(`expected 468 vertices, got ${v.length}`);
    // obj: centimetres, y up, z toward viewer -> world: metres, y down, z away from camera
    return v.map(([x, y, z]) => [x * 0.01, -y * 0.01, -z * 0.01]);
  } catch (e) {
    console.warn(`face model not available (${e.message}); face will be null`);
    return null;
  }
}

const faceModel = await loadFace();
const HEAD = [0, -0.66, -0.02]; // where the canonical model's origin sits in the body

function faceAt(t) {
  if (!faceModel) return { face: null, bs: null };
  const blink = Math.max(0, 1 - Math.abs(t - 0.5) / 0.08) + Math.max(0, 1 - Math.abs(t - 2.2) / 0.08);
  const mouth = Math.max(0, 1 - Math.abs(t - 1.5) / 0.3);
  const yaw = 0.12 * Math.sin(t * 2.1); // small head turn
  const pts = faceModel.map((p) => {
    let q = [...p];
    // blink: pull upper lids (eye area above the eye centre) down
    const eyeY = -0.026;
    if (Math.abs(Math.abs(q[0]) - 0.031) < 0.022 && q[1] < eyeY && q[1] > eyeY - 0.012) q[1] += blink * 0.006;
    // mouth: drop the lower lip / jaw region
    if (q[1] > 0.035 && Math.abs(q[0]) < 0.035) q[1] += mouth * 0.012 * Math.min(1, (q[1] - 0.035) / 0.01);
    q = rot(q, [0, 1, 0], yaw);
    return add(q, HEAD);
  });
  const centroid = (ids) => mul(ids.reduce((s, i) => add(s, pts[i]), [0, 0, 0]), 1 / ids.length);
  const rIris = centroid([33, 133, 159, 145]);
  const lIris = centroid([362, 263, 386, 374]);
  const ring = (c) => [c, add(c, [0.005, 0, 0]), add(c, [0, -0.005, 0]), add(c, [-0.005, 0, 0]), add(c, [0, 0.005, 0])];
  const all = [...pts, ...ring(rIris), ...ring(lIris)];
  const bs = { eyeBlinkLeft: r4(Math.min(1, blink)), eyeBlinkRight: r4(Math.min(1, blink)), jawOpen: r4(mouth * 0.6), browInnerUp: r4(mouth * 0.5) };
  return { face: all, bs };
}

const frames = [];
const N = FPS * SECONDS;
for (let i = 0; i < N; i++) {
  const t = i / FPS;
  const P = new Array(33);
  const raise = ease(t / 1.0);
  const wave = t > 1.0 && t < 2.2 ? Math.sin((t - 1.0) * 2 * Math.PI * 2) * 0.35 * ease((t - 1.0) / 0.2) * ease((2.2 - t) / 0.2) : 0;
  const curl = ease((t - 1.6) / 0.4) * (1 - ease((t - 2.2) / 0.4));

  const RS = [-0.18, -0.5, 0], LS = [0.18, -0.5, 0];
  // right arm (subject's right = image left = -x)
  const rUpper = norm(lerp3([-0.08, 1, 0.02], [-0.3, 0.75, -0.5], raise));
  const rElbow = add(RS, mul(rUpper, 0.28));
  const rFore0 = norm(lerp3([0, 1, -0.05], [0.3, -1, -0.25], raise));
  const rFore = rot(rFore0, [0, 0, 1], wave);
  const rWrist = add(rElbow, mul(rFore, 0.25));
  // palm: at rest faces the thigh (+x for the right hand), raised faces the camera (-z)
  const rN = norm(lerp3([1, 0, 0], [0, 0, -1], raise));
  const rHand = hand(rWrist, rFore, rN, "right", curl, curl);
  // left arm at rest with a slight sway
  const sway = 0.03 * Math.sin(t * 3);
  const lUpper = norm([0.08 + sway, 1, 0.02]);
  const lElbow = add(LS, mul(lUpper, 0.28));
  const lFore = norm([0.02, 1, -0.08]);
  const lWrist = add(lElbow, mul(lFore, 0.25));
  const lHand = hand(lWrist, lFore, [-1, 0, 0], "left", 0.25, 0.2);

  // head points (pose)
  const yaw = 0.12 * Math.sin(t * 2.1);
  const hp = (p) => add(rot(p, [0, 1, 0], yaw), HEAD);
  P[0] = hp([0, -0.02, -0.1]);
  P[1] = hp([0.015, -0.045, -0.085]); P[2] = hp([0.031, -0.045, -0.08]); P[3] = hp([0.045, -0.045, -0.075]);
  P[4] = hp([-0.015, -0.045, -0.085]); P[5] = hp([-0.031, -0.045, -0.08]); P[6] = hp([-0.045, -0.045, -0.075]);
  P[7] = hp([0.075, -0.03, 0]); P[8] = hp([-0.075, -0.03, 0]);
  P[9] = hp([0.022, 0.03, -0.085]); P[10] = hp([-0.022, 0.03, -0.085]);
  P[11] = LS; P[12] = RS; P[13] = lElbow; P[14] = rElbow; P[15] = lWrist; P[16] = rWrist;
  P[17] = lHand[17]; P[18] = rHand[17]; P[19] = lHand[5]; P[20] = rHand[5]; P[21] = lHand[2]; P[22] = rHand[2];
  P[23] = [0.1, 0, 0]; P[24] = [-0.1, 0, 0];
  P[25] = [0.1, 0.45, -0.02]; P[26] = [-0.1, 0.45, -0.02]; P[27] = [0.1, 0.88, 0]; P[28] = [-0.1, 0.88, 0];
  P[29] = [0.1, 0.92, 0.04]; P[30] = [-0.1, 0.92, 0.04]; P[31] = [0.1, 0.94, -0.08]; P[32] = [-0.1, 0.94, -0.08];

  const vis = (j) => (j >= 25 ? 0.05 : j >= 23 ? 0.6 : 0.99);
  const pose = P.map((p, j) => [...toImg(p), vis(j)]);
  const poseWorld = P.map((p) => p.map(r4));

  const handImg = (pts) => { const z0 = pts[0][2]; return pts.map((p) => { const q = toImg(p); return [q[0], q[1], r4(((p[2] - z0) * K) / W)]; }); };
  const handWorld = (pts) => { const c = mul([0, 5, 9, 13, 17].reduce((s, j) => add(s, pts[j]), [0, 0, 0]), 0.2); return pts.map((p) => sub(p, c).map(r4)); };

  const lost = i >= 30 && i <= 40;
  const { face, bs } = faceAt(t);
  frames.push({
    i, t: r4(t),
    pose, poseWorld,
    face: face ? face.map(toImg) : null,
    faceBlendshapes: bs,
    leftHand: lost ? null : handImg(lHand),
    leftHandWorld: lost ? null : handWorld(lHand),
    rightHand: handImg(rHand),
    rightHandWorld: handWorld(rHand),
  });
}

const motion = {
  version: 1,
  name: "wave",
  motion_id: null,
  gloss: null,
  source: { file: null, dataset: "synthetic", license: "CC0 (synthetic fixture; face mesh from MediaPipe canonical model, Apache 2.0)", signer: null, start_s: 0, end_s: SECONDS },
  fps: FPS, width: W, height: H,
  dominant_hand: "right",
  mirrored: false,
  extractor: { name: "puppet/scripts/make-fixture.mjs", version: "1", model: null },
  cleaned: false,
  cleanup: null,
  frames,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(motion));
console.log(`wrote ${out}: ${frames.length} frames`);
