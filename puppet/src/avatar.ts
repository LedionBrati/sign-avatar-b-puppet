// The realistic reference avatar (puppet/models/signer.glb, built by puppet/avatar/build.mjs): a plain glTF
// with a Mixamo-named skeleton. It gets a VRM humanoid wrapper (normalized bones, same API as a .vrm file),
// so every solver, the clean-up and the measurements in src/vrm.ts work on it unchanged.
// Also here: the avatar's hand geometry for src/hand.ts and the per-finger colours of the segmentation pass.
import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMHumanoid, type VRMHumanBones, type VRMHumanBoneName, type VRMMeta } from "@pixiv/three-vrm";
import { FINGERS, FINGER_LM, geomFromPoints, palmFrame, thumbPlaneNormal, toLocal, type Finger, type HandGeom, type PalmFrame, type Side, type V3 } from "./hand";

/** Mixamo bone name (without the "mixamorig:" prefix) -> VRM humanoid bone name */
const MIXAMO: Record<string, VRMHumanBoneName> = {
  Hips: "hips", Spine: "spine", Spine1: "chest", Spine2: "upperChest", Neck: "neck", Head: "head",
  LeftShoulder: "leftShoulder", LeftArm: "leftUpperArm", LeftForeArm: "leftLowerArm", LeftHand: "leftHand",
  RightShoulder: "rightShoulder", RightArm: "rightUpperArm", RightForeArm: "rightLowerArm", RightHand: "rightHand",
  LeftUpLeg: "leftUpperLeg", LeftLeg: "leftLowerLeg", LeftFoot: "leftFoot", LeftToeBase: "leftToes",
  RightUpLeg: "rightUpperLeg", RightLeg: "rightLowerLeg", RightFoot: "rightFoot", RightToeBase: "rightToes",
};
for (const S of ["Left", "Right"]) {
  const s = S.toLowerCase();
  MIXAMO[`${S}HandThumb1`] = `${s}ThumbMetacarpal` as VRMHumanBoneName;
  MIXAMO[`${S}HandThumb2`] = `${s}ThumbProximal` as VRMHumanBoneName;
  MIXAMO[`${S}HandThumb3`] = `${s}ThumbDistal` as VRMHumanBoneName;
  for (const [mx, vr] of [["Index", "Index"], ["Middle", "Middle"], ["Ring", "Ring"], ["Pinky", "Little"]]) {
    MIXAMO[`${S}Hand${mx}1`] = `${s}${vr}Proximal` as VRMHumanBoneName;
    MIXAMO[`${S}Hand${mx}2`] = `${s}${vr}Intermediate` as VRMHumanBoneName;
    MIXAMO[`${S}Hand${mx}3`] = `${s}${vr}Distal` as VRMHumanBoneName;
  }
}
const mixamoKey = (name: string) => /^mixamorig:?(.+)$/.exec(name)?.[1] ?? null;

/** Wrap a Mixamo-rigged glTF in a VRM (humanoid only: no expressions, no spring bones). */
export function vrmFromGltf(gltf: GLTF, name = "signer"): VRM {
  const bones: Partial<VRMHumanBones> = {};
  gltf.scene.traverse((o) => {
    const k = mixamoKey(o.name);
    const vrmName = k ? MIXAMO[k] : undefined;
    if (vrmName && !bones[vrmName]) bones[vrmName] = { node: o };
  });
  for (const req of ["hips", "spine", "head", "leftUpperArm", "rightUpperArm", "leftHand", "rightHand"] as VRMHumanBoneName[])
    if (!bones[req]) throw new Error(`avatar has no ${req} bone (expected a Mixamo-named skeleton)`);
  const humanoid = new VRMHumanoid(bones as VRMHumanBones, { autoUpdateHumanBones: true });
  gltf.scene.add(humanoid.normalizedHumanBonesRoot);
  const meta = { metaVersion: "1", name, authors: ["MakeHuman / MPFB (CC0)"], licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" } as unknown as VRMMeta;
  return new VRM({ scene: gltf.scene, meta, humanoid });
}

const cap = (s: Side) => (s === "left" ? "Left" : "Right");
const VRM_FINGER: Record<Finger, string> = { thumb: "Thumb", index: "Index", middle: "Middle", ring: "Ring", pinky: "Little" };
/** the three humanoid bones of a finger, base first */
export function fingerBones(side: Side, f: Finger): VRMHumanBoneName[] {
  const segs = f === "thumb" ? ["Metacarpal", "Proximal", "Distal"] : ["Proximal", "Intermediate", "Distal"];
  return segs.map((s) => `${side}${VRM_FINGER[f]}${s}` as VRMHumanBoneName);
}

/**
 * Where a hand's joints are, as 21 MediaPipe-ordered world points, from the normalized bones of the posed avatar.
 * Fingertips come from the rig's tip bones when it has them (signer.glb), else from the distal bone extended
 * by `tipOffset` (its rest tip vector, in the distal bone's own frame).
 */
export class AvatarHand {
  geom: HandGeom;
  /** rest palm frame (world, avatar at rest; normalized bones have identity rest rotations) */
  rest: PalmFrame;
  /** rest vector distal joint -> fingertip (world at rest = the distal bone's own frame) */
  tipOffset: Record<Finger, THREE.Vector3> = {} as any;
  /** palm-local normal of the rest thumb's bend plane (src/hand.ts thumbPlaneNormal) */
  thumbPlaneNormal: V3;

  constructor(private vrm: VRM, public side: Side, tipNodes: Partial<Record<Finger, THREE.Object3D>>) {
    vrm.scene.updateMatrixWorld(true);
    const hum = vrm.humanoid;
    for (const f of FINGERS) {
      const [, b1, b2] = fingerBones(side, f);
      const distal = hum.getNormalizedBoneNode(b2)!, mid = hum.getNormalizedBoneNode(b1)!;
      const tip = tipNodes[f];
      const dW = distal.getWorldPosition(new THREE.Vector3());
      const tW = tip ? tip.getWorldPosition(new THREE.Vector3()) : dW.clone().add(dW.clone().sub(mid.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.8));
      this.tipOffset[f] = tW.sub(dW); // world = distal-local at rest (identity rest rotation)
    }
    const pts = this.points();
    const F = palmFrame(pts, side);
    if (!F) throw new Error(`degenerate ${side} hand on the avatar`);
    this.rest = F;
    const L = pts.map((p) => toLocal(F, p));
    this.geom = geomFromPoints(L);
    this.thumbPlaneNormal = thumbPlaneNormal([L[2][0] - L[1][0], L[2][1] - L[1][1], L[2][2] - L[1][2]]);
  }

  /** the 21 joints of the hand as posed now (world) */
  points(): V3[] {
    const hum = this.vrm.humanoid;
    const w = (n: THREE.Object3D) => n.getWorldPosition(new THREE.Vector3());
    const pts: V3[] = new Array(21);
    pts[0] = w(hum.getNormalizedBoneNode(`${this.side}Hand` as VRMHumanBoneName)!).toArray() as V3;
    const q = new THREE.Quaternion();
    for (const f of FINGERS) {
      const nodes = fingerBones(this.side, f).map((b) => hum.getNormalizedBoneNode(b)!);
      const idx = FINGER_LM[f];
      nodes.forEach((n, j) => { pts[idx[j]] = w(n).toArray() as V3; });
      const distal = nodes[2];
      const tip = w(distal).add(this.tipOffset[f].clone().applyQuaternion(distal.getWorldQuaternion(q)));
      pts[idx[3]] = tip.toArray() as V3;
    }
    return pts;
  }
}

/** tip bones of a Mixamo rig (mixamorig:LeftHandIndex4 ...), if present */
export function mixamoTips(scene: THREE.Object3D, side: Side): Partial<Record<Finger, THREE.Object3D>> {
  const out: Partial<Record<Finger, THREE.Object3D>> = {};
  const MX: Record<Finger, string> = { thumb: "Thumb", index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky" };
  scene.traverse((o) => {
    const k = mixamoKey(o.name);
    if (!k) return;
    for (const f of FINGERS) if (k === `${cap(side)}Hand${MX[f]}4`) out[f] = o;
  });
  return out;
}

// ---------------------------------------------------------------- segmentation colours
/** Segmentation pass colours (sRGB 0..255). Same colours for both hands; the palms differ by side. */
export const SEG_COLORS: Record<string, [number, number, number]> = {
  thumb: [255, 0, 0], index: [0, 255, 0], middle: [0, 0, 255], ring: [255, 255, 0], pinky: [255, 0, 255],
  palmRight: [0, 255, 255], palmLeft: [255, 128, 0], head: [200, 200, 200], body: [60, 60, 60],
};

/** humanoid bone name -> segmentation class */
function segClass(bone: string | undefined): string {
  if (!bone) return "body";
  const m = /^(left|right)(Thumb|Index|Middle|Ring|Little)/.exec(bone);
  if (m) return m[2] === "Little" ? "pinky" : m[2].toLowerCase();
  if (bone === "leftHand") return "palmLeft";
  if (bone === "rightHand") return "palmRight";
  if (bone === "head" || bone === "neck" || /Eye|jaw/.test(bone)) return "head";
  return "body";
}

/**
 * Give every skinned mesh a vertex colour per segmentation class (from its strongest bone weight) and return a
 * material that shows it. Raw bone node -> humanoid name comes from the VRM humanoid; hair and anything not
 * skinned to a humanoid bone falls back to its nearest humanoid ancestor, then "body".
 */
export function buildSegmentation(vrm: VRM): THREE.Material {
  const rawToHuman = new Map<THREE.Object3D, string>();
  for (const [name, b] of Object.entries(vrm.humanoid.humanBones)) if (b?.node) rawToHuman.set(b.node, name);
  const humanOf = (o: THREE.Object3D | null): string | undefined => {
    for (let n = o; n; n = n.parent) { const h = rawToHuman.get(n); if (h) return h; }
    return undefined;
  };
  const c = new THREE.Color();
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry as THREE.BufferGeometry;
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    for (let i = 0; i < n; i++) {
      let bone: THREE.Object3D | null = null;
      if (mesh.isSkinnedMesh && si && sw) {
        let best = -1;
        for (let k = 0; k < 4; k++) { const wk = sw.getComponent(i, k); if (wk > best) { best = wk; bone = mesh.skeleton.bones[si.getComponent(i, k)] ?? null; } }
      } else bone = mesh;
      const rgb = SEG_COLORS[segClass(humanOf(bone))];
      c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  });
  return new THREE.MeshBasicMaterial({ vertexColors: true });
}
