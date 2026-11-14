// Drive a VRM avatar from a motion frame, render it at the avatar framing, and measure how far
// the avatar's bones end up from the tracked landmarks (retargeting error, in degrees).
//
// Two solvers:
//  - "kalidokit": kalidokit Pose.solve / Hand.solve (the GSL repo's approach). Kalidokit is written
//    for selfie/mirror mode (its "Right" arm reads the subject's LEFT landmarks), so we feed it a
//    left-right mirrored frame; that makes avatar-right follow subject-right, i.e. the puppet matches
//    the source video instead of mirroring it. Its euler angles target VRM0 axes, so x and z are
//    negated for VRM1 models.
//  - "direct": aims each bone straight at the tracked landmarks (upper arm with elbow bend plane,
//    forearm with palm twist, hand with palm normal, every finger joint with swing, so spread is kept).
//
// Coordinates: MediaPipe is x image-right, y down, z away from the camera. The avatar faces the camera
// (+Z toward the camera, y up), so subject-left = image-right = avatar-left = +X: a point maps to (x, -y, -z).

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import * as Kalidokit from "kalidokit";
import type { Motion, MotionFrame, Vec3 } from "./motion";
import { angleDeg, mirrorFrame, mpToThree, palmNormal, sub3 } from "./geom";

export type Solver = "kalidokit" | "direct";

export interface PuppetOptions {
  solver?: Solver;
  /** black top, skin-tone hands, dark wall (README §6.4) */
  mannequin?: boolean;
  /** render hand close-up insets */
  closeup?: boolean;
  background?: string;
}

export interface RetargetReport {
  frame: number;
  /** parts the tracker did not deliver (tracking failures) */
  tracking: string[];
  /** bones whose avatar direction differs from the landmarks by more than the threshold (retargeting failures) */
  retarget: string[];
  /** degrees between avatar bone and tracked bone; null when the part was not tracked */
  err: Record<string, number | null>;
}

export const RETARGET_THRESHOLD_DEG = 30;

type Side = "left" | "right";
const SIDES: Side[] = ["left", "right"];
const cap = (s: Side) => (s === "left" ? "Left" : "Right");
const FINGER_BONES = ["Thumb", "Index", "Middle", "Ring", "Little"] as const;
const FINGER_LM: Record<(typeof FINGER_BONES)[number], number[]> = {
  Thumb: [1, 2, 3, 4], Index: [5, 6, 7, 8], Middle: [9, 10, 11, 12], Ring: [13, 14, 15, 16], Little: [17, 18, 19, 20],
};
const segNames = (finger: string) => (finger === "Thumb" ? ["Metacarpal", "Proximal", "Distal"] : ["Proximal", "Intermediate", "Distal"]);
const boneName = (side: Side, finger: string, seg: string) => `${side}${finger}${seg}` as VRMHumanBoneName;

const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
const _m = new THREE.Matrix4();

export class VrmPuppet {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly closeCam = new THREE.PerspectiveCamera(28, 1, 0.01, 10);
  vrm: VRM | null = null;
  opts: Required<PuppetOptions>;
  private brow: { mesh: THREE.Mesh; up: number | null; down: number | null }[] = [];

  constructor(public canvas: HTMLCanvasElement, public width: number, public height: number, opts: PuppetOptions = {}) {
    this.opts = { solver: opts.solver ?? "direct", mannequin: opts.mannequin ?? false, closeup: opts.closeup ?? false, background: opts.background ?? (opts.mannequin ? "#2b2b2f" : "#1d2026") };
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(this.opts.background);
    this.camera = new THREE.PerspectiveCamera(24, width / height, 0.05, 20);
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(0.6, 1.6, 2.0);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8); fill.position.set(-1.2, 1.0, 1.5);
    this.scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.9));
  }

  async load(url: string): Promise<VRM> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM;
    if (!vrm) throw new Error(`${url} is not a VRM file`);
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM0 models face -Z; turn them to face the camera like VRM1
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    if (vrm.springBoneManager) vrm.springBoneManager.reset();
    this.scene.add(vrm.scene);
    this.vrm = vrm;
    if (this.opts.mannequin) this.applyMannequin();
    // brow morphs are not VRM presets; VRoid models have Fcl_BRW_Surprised / Fcl_BRW_Angry
    vrm.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.morphTargetDictionary) return;
      const find = (re: RegExp) => { const k = Object.keys(mesh.morphTargetDictionary!).find((n) => re.test(n)); return k === undefined ? null : mesh.morphTargetDictionary![k]; };
      const up = find(/BRW_Surprised$/i), down = find(/BRW_Angry$/i);
      if (up !== null || down !== null) this.brow.push({ mesh, up, down });
    });
    this.restPose();
    vrm.update(0);
    this.frameCamera();
    return vrm;
  }

  private applyMannequin() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xc8957a, roughness: 0.75 });
    const top = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.9 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x2a1d17, roughness: 0.8 });
    this.vrm!.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pick = (m: THREE.Material) => {
        const n = m.name.toLowerCase();
        if (/eye|face|mouth|brow|lash|line/.test(n) && !/skin/.test(n)) return m; // keep facial features
        if (/skin|body/.test(n)) return skin;
        if (/hair/.test(n)) return hair;
        return top;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(pick) : pick(mesh.material);
    });
  }

  private node(name: VRMHumanBoneName): THREE.Object3D | null {
    return this.vrm?.humanoid.getNormalizedBoneNode(name) ?? null;
  }
  private raw(name: VRMHumanBoneName): THREE.Object3D | null {
    return this.vrm?.humanoid.getRawBoneNode(name) ?? null;
  }
  private wpos(name: VRMHumanBoneName): THREE.Vector3 | null {
    const n = this.raw(name);
    return n ? n.getWorldPosition(new THREE.Vector3()) : null;
  }

  /** Waist-up, camera at chest height, 3:4 (README §6.4). */
  frameCamera() {
    this.vrm!.scene.updateMatrixWorld(true);
    const hips = this.wpos("hips")!, head = this.wpos("head")!;
    const chest = this.wpos("upperChest") ?? this.wpos("chest") ?? head.clone().lerp(hips, 0.5);
    const top = head.y + (head.y - hips.y) * 0.62; // head top (hair) plus a little air
    const bottom = hips.y - (head.y - hips.y) * 0.25; // below the waist, so hands resting on the lap stay in frame
    const mid = (top + bottom) / 2;
    const span = top - bottom;
    const dist = span / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.set(0, chest.y, dist + chest.z);
    this.camera.lookAt(0, mid, chest.z);
    this.camera.updateProjectionMatrix();
  }

  /** Arms down, relaxed fingers: used when the pose is missing. */
  restPose() {
    const vrm = this.vrm!;
    vrm.humanoid.resetNormalizedPose();
    const down = 1.25;
    this.node("leftUpperArm")?.rotation.set(0, 0, -down);
    this.node("rightUpperArm")?.rotation.set(0, 0, down);
    this.node("leftLowerArm")?.rotation.set(0, -0.15, 0);
    this.node("rightLowerArm")?.rotation.set(0, 0.15, 0);
    for (const s of SIDES) this.relaxFingers(s);
  }

  private relaxFingers(side: Side) {
    const sign = side === "left" ? -1 : 1; // VRM1: curling toward the palm is -Z for the left hand, +Z for the right
    for (const f of FINGER_BONES) {
      if (f === "Thumb") continue;
      for (const seg of segNames(f)) this.node(boneName(side, f, seg))?.rotation.set(0, 0, sign * 0.25);
    }
  }

  /** Apply one frame; returns tracking and retargeting problems for it. */
  applyFrame(f: MotionFrame | null, m: Motion): RetargetReport {
    const vrm = this.vrm!;
    const report: RetargetReport = { frame: f?.i ?? -1, tracking: [], retarget: [], err: {} };
    this.restPose();
    if (!f) { report.tracking.push("no frame"); this.finish(); return report; }
    if (!f.pose || !f.poseWorld) report.tracking.push("pose");
    if (!f.leftHand) report.tracking.push("L hand");
    if (!f.rightHand) report.tracking.push("R hand");
    if (!f.face) report.tracking.push("face");

    this.solveHead(f, m);
    if (this.opts.solver === "kalidokit") this.solveKalidokit(f, m);
    else this.solveDirect(f, m);
    this.solveExpressions(f, m);
    this.finish();
    this.measure(f, m, report);
    return report;
  }

  private finish() {
    this.vrm!.update(0); // normalized -> raw bones, constraints, expressions (spring bones get dt = 0)
    this.applyBrowMorphs();
    this.vrm!.scene.updateMatrixWorld(true);
  }

  // ---------------------------------------------------------------- head and face
  private solveHead(f: MotionFrame, m: Motion) {
    // head orientation from the face mesh: x axis = right eye outer (33) -> left eye outer (263), y axis = chin (152) -> forehead (10)
    let xAxis: THREE.Vector3 | null = null, yAxis: THREE.Vector3 | null = null;
    const S: Vec3 = [m.width, m.height, m.width];
    const sc = (p: number[]) => [p[0] * S[0], p[1] * S[1], p[2] * S[2]];
    if (f.face) {
      xAxis = v3(mpToThree(sub3(sc(f.face[263]), sc(f.face[33]))));
      yAxis = v3(mpToThree(sub3(sc(f.face[10]), sc(f.face[152]))));
    } else if (f.poseWorld) { // ears and nose
      const P = f.poseWorld;
      xAxis = v3(mpToThree(sub3(P[7], P[8])));
      const earMid = [(P[7][0] + P[8][0]) / 2, (P[7][1] + P[8][1]) / 2, (P[7][2] + P[8][2]) / 2];
      const toNose = v3(mpToThree(sub3(P[0], earMid))).normalize();
      yAxis = new THREE.Vector3().crossVectors(toNose, xAxis).normalize(); // up = forward x right... (z x x = y)
      if (yAxis.y < 0) yAxis.negate();
    }
    if (!xAxis || !yAxis) return;
    const target = basisQuat(xAxis, yAxis);
    if (!target) return;
    // the face mesh's "up" (chin -> forehead) leans back ~ 10 deg relative to the head bone; ignore that offset
    const neck = this.node("neck"), head = this.node("head");
    if (!neck || !head) return;
    const parentQ = neck.parent!.getWorldQuaternion(new THREE.Quaternion());
    const rel = parentQ.clone().invert().multiply(target);
    neck.quaternion.identity().slerp(rel, 0.45);
    neck.updateMatrixWorld(true);
    const hq = head.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(target);
    head.quaternion.copy(hq);
  }

  private solveExpressions(f: MotionFrame, m: Motion) {
    const em = this.vrm!.expressionManager;
    if (!em) return;
    for (const n of ["aa", "ee", "ih", "oh", "ou", "blinkLeft", "blinkRight", "blink"]) em.setValue(n, 0);
    this.browUp = 0; this.browDown = 0;
    const bs = f.faceBlendshapes;
    if (bs && Object.keys(bs).length) {
      const g = (k: string) => bs[k] ?? 0;
      // ARKit names are the subject's own left/right, VRM blinkLeft is the avatar's left eye: same side
      em.setValue("blinkLeft", clamp01((g("eyeBlinkLeft") - 0.15) / 0.55));
      em.setValue("blinkRight", clamp01((g("eyeBlinkRight") - 0.15) / 0.55));
      em.setValue("aa", clamp01(g("jawOpen") * 1.4));
      em.setValue("ou", clamp01(Math.max(g("mouthFunnel"), g("mouthPucker")) * 0.9));
      em.setValue("ee", clamp01((g("mouthStretchLeft") + g("mouthStretchRight") + g("mouthSmileLeft") + g("mouthSmileRight")) * 0.35));
      this.browUp = clamp01((g("browInnerUp") * 1.2 + (g("browOuterUpLeft") + g("browOuterUpRight")) * 0.5));
      this.browDown = clamp01((g("browDownLeft") + g("browDownRight")) * 0.8);
    } else if (f.face) {
      const pts = f.face.map(([x, y, z]) => ({ x, y, z }));
      const face = Kalidokit.Face.solve(pts, { runtime: "mediapipe", imageSize: { width: m.width, height: m.height } });
      if (face) {
        em.setValue("blinkLeft", clamp01(1 - face.eye.r)); // kalidokit's eye labels are mirror-mode
        em.setValue("blinkRight", clamp01(1 - face.eye.l));
        em.setValue("aa", face.mouth.shape.A); em.setValue("ee", face.mouth.shape.E); em.setValue("ih", face.mouth.shape.I);
        em.setValue("oh", face.mouth.shape.O); em.setValue("ou", face.mouth.shape.U);
        this.browUp = clamp01(face.brow);
      }
    }
  }
  private browUp = 0;
  private browDown = 0;
  private applyBrowMorphs() {
    for (const b of this.brow) {
      const inf = b.mesh.morphTargetInfluences!;
      if (b.up !== null) inf[b.up] = this.browUp;
      if (b.down !== null) inf[b.down] = this.browDown;
    }
  }

  // ---------------------------------------------------------------- kalidokit solver
  private rig(name: VRMHumanBoneName, r: { x: number; y: number; z: number } | undefined, damp = 1) {
    const n = this.node(name);
    if (!n || !r) return;
    // kalidokit targets VRM0 axes; VRM1 normalized bones face the other way: negate x and z
    const vrm1 = this.vrm!.meta?.metaVersion === "1";
    n.quaternion.setFromEuler(new THREE.Euler((vrm1 ? -r.x : r.x) * damp, r.y * damp, (vrm1 ? -r.z : r.z) * damp, "XYZ"));
  }

  private solveKalidokit(f: MotionFrame, m: Motion) {
    const mf = mirrorFrame(f);
    if (mf.pose && mf.poseWorld) {
      const lm3d = mf.poseWorld.map(([x, y, z], k) => ({ x, y, z, visibility: mf.pose![k][3] ?? 1 }));
      const lm2d = mf.pose.map(([x, y, z, v]) => ({ x, y, z, visibility: v ?? 1 }));
      const pose: any = Kalidokit.Pose.solve(lm3d, lm2d, { runtime: "mediapipe", imageSize: { width: m.width, height: m.height }, enableLegs: false });
      if (pose) {
        this.rig("spine", pose.Spine, 0.45);
        this.rig("chest", pose.Spine, 0.25);
        this.rig("rightUpperArm", pose.RightUpperArm);
        this.rig("rightLowerArm", pose.RightLowerArm);
        this.rig("leftUpperArm", pose.LeftUpperArm);
        this.rig("leftLowerArm", pose.LeftLowerArm);
        for (const side of SIDES) {
          // mirrored frame: its left hand is the subject's right hand -> kalidokit "Right"
          const lm = side === "right" ? mf.leftHand : mf.rightHand;
          const K = cap(side);
          if (!lm) { this.rig(`${side}Hand` as VRMHumanBoneName, pose[`${K}Hand`]); continue; }
          const hand = Kalidokit.Hand.solve(lm.map(([x, y, z]) => ({ x, y, z })), K) as Record<string, { x: number; y: number; z: number }> | undefined;
          if (!hand) continue;
          this.rig(`${side}Hand` as VRMHumanBoneName, { z: pose[`${K}Hand`].z, y: hand[`${K}Wrist`].y, x: hand[`${K}Wrist`].x });
          for (const fg of FINGER_BONES) {
            const kSegs = ["Proximal", "Intermediate", "Distal"]; // kalidokit names (VRM0 thumb naming)
            segNames(fg).forEach((seg, k) => this.rig(boneName(side, fg, seg), hand[`${K}${fg}${kSegs[k]}`]));
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- direct solver
  /**
   * Rotate a normalized bone so its rest direction (towards `childName`) points along `dir` (avatar world axes).
   * With `up`, also twist it so the rest vector `restUpLocal` (bone-local) lines up with `up` (orthogonalised).
   * `upWeight` < 1 blends towards the pure swing (used when the twist reference is unreliable).
   */
  private aim(name: VRMHumanBoneName, childName: VRMHumanBoneName | THREE.Vector3, dir: THREE.Vector3, restUpLocal?: THREE.Vector3, up?: THREE.Vector3, upWeight = 1) {
    const n = this.node(name);
    if (!n || dir.lengthSq() < 1e-12) return;
    const restLocal = childName instanceof THREE.Vector3 ? childName.clone() : this.node(childName)?.position.clone();
    if (!restLocal || restLocal.lengthSq() < 1e-12) return;
    n.parent!.updateWorldMatrix(true, false);
    const parentQ = n.parent!.getWorldQuaternion(new THREE.Quaternion());
    const restW = restLocal.normalize().applyQuaternion(parentQ);
    const d = dir.clone().normalize();
    const swing = new THREE.Quaternion().setFromUnitVectors(restW, d);
    let world = swing.clone().multiply(parentQ);
    if (restUpLocal && up && upWeight > 0) {
      const restUpW = restUpLocal.clone().applyQuaternion(parentQ);
      const full = twoAxisQuat(restW, restUpW, d, up);
      if (full) world = swing.multiply(parentQ).slerp(full.multiply(parentQ), upWeight);
    }
    n.quaternion.copy(parentQ.invert().multiply(world));
    n.updateMatrixWorld(true);
  }

  private solveDirect(f: MotionFrame, m: Motion) {
    const P = f.poseWorld;
    if (!P || !f.pose) return;
    const vis = (k: number) => f.pose![k][3] ?? 1;
    const W = (k: number) => v3(mpToThree(P[k]));
    // torso: shoulder line gives yaw and roll, split between spine and chest
    const shoulderLine = W(11).sub(W(12)); // subject left - right = +X at rest
    if (shoulderLine.lengthSq() > 1e-6) {
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), shoulderLine.normalize());
      const half = new THREE.Quaternion().slerp(q, 0.5);
      this.node("spine")?.quaternion.copy(half);
      (this.node("chest") ?? this.node("upperChest"))?.quaternion.copy(half);
    }
    const FWD = new THREE.Vector3(0, 0, 1);
    for (const side of SIDES) {
      const [sh, el, wr] = side === "left" ? [11, 13, 15] : [12, 14, 16];
      if (Math.min(vis(el), vis(wr)) < 0.3) continue; // arm not visible: keep it at rest (logged as tracking)
      const upper = W(el).sub(W(sh)), fore = W(wr).sub(W(el));
      // upper arm: direction + elbow bend plane (the forearm swings toward the rest +Z "front" of the upper arm)
      const bendW = fore.clone().sub(upper.clone().normalize().multiplyScalar(fore.dot(upper.clone().normalize())));
      const bendWeight = THREE.MathUtils.clamp(bendW.length() / (fore.length() * 0.35 + 1e-6), 0, 1);
      this.aim(`${side}UpperArm`, `${side}LowerArm`, upper, FWD, bendW, bendWeight);
      const hand = side === "left" ? f.leftHand : f.rightHand;
      const handW = side === "left" ? f.leftHandWorld : f.rightHandWorld;
      const H = handW ? (k: number) => v3(mpToThree(handW[k])) : hand ? (k: number) => v3(mpToThree([hand[k][0] * m.width, hand[k][1] * m.height, hand[k][2] * m.width])) : null;
      if (!H || !hand) { this.aim(`${side}LowerArm`, `${side}Hand`, fore); continue; }
      const palmN = v3(mpToThree(handW ? palmNormal(handW, side) : palmNormal(hand, side, [m.width, m.height, m.width])));
      const restPalm = this.restPalmNormal(side);
      // forearm: direction + pronation/supination from the palm normal
      this.aim(`${side}LowerArm`, `${side}Hand`, fore, restPalm, palmN, 1);
      // hand: wrist -> middle knuckle, twisted by the palm normal
      this.aim(`${side}Hand`, `${side}MiddleProximal`, H(9).sub(H(0)), restPalm, palmN, 1);
      // fingers: swing each joint toward the next landmark (keeps curl and spread)
      for (const fg of FINGER_BONES) {
        const lm = FINGER_LM[fg];
        const segs = segNames(fg);
        for (let k = 0; k < 3; k++) {
          const child = k < 2 ? boneName(side, fg, segs[k + 1]) : this.node(boneName(side, fg, segs[2]))!.position.clone();
          this.aim(boneName(side, fg, segs[k]), child, H(lm[k + 1]).sub(H(lm[k])));
        }
      }
    }
  }

  /** world vector -> local frame of a bone's parent, assuming the bone itself is still at rest */
  private toLocal(name: VRMHumanBoneName, w: THREE.Vector3): THREE.Vector3 {
    const n = this.node(name)!;
    n.parent!.updateWorldMatrix(true, false);
    return w.clone().applyQuaternion(n.parent!.getWorldQuaternion(new THREE.Quaternion()).invert());
  }

  /** palm normal of the avatar's rest hand in hand-local axes, from the same formula as the landmarks */
  private restPalmNormal(side: Side): THREE.Vector3 {
    const idx = this.node(`${side}IndexProximal`)!.position, lit = this.node(`${side}LittleProximal`)!.position;
    const n = side === "right" ? new THREE.Vector3().crossVectors(idx, lit) : new THREE.Vector3().crossVectors(lit, idx);
    return n.normalize();
  }

  // ---------------------------------------------------------------- measurement
  private measure(f: MotionFrame, m: Motion, r: RetargetReport) {
    const P = f.poseWorld;
    const dirAv = (a: VRMHumanBoneName, b: VRMHumanBoneName) => { const pa = this.wpos(a), pb = this.wpos(b); return pa && pb ? pb.sub(pa).toArray() : null; };
    for (const side of SIDES) {
      const S = side === "left" ? "L" : "R";
      const [sh, el, wr] = side === "left" ? [11, 13, 15] : [12, 14, 16];
      const okArm = P && f.pose && Math.min(f.pose[el][3] ?? 1, f.pose[wr][3] ?? 1) >= 0.3;
      const ua = dirAv(`${side}UpperArm`, `${side}LowerArm`), la = dirAv(`${side}LowerArm`, `${side}Hand`);
      r.err[`${S} upper arm`] = okArm && ua ? angleDeg(ua, mpToThree(sub3(P![el], P![sh]))) : null;
      r.err[`${S} forearm`] = okArm && la ? angleDeg(la, mpToThree(sub3(P![wr], P![el]))) : null;
      const hand = side === "left" ? f.leftHand : f.rightHand;
      const handW = side === "left" ? f.leftHandWorld : f.rightHandWorld;
      if (!hand) { r.err[`${S} hand dir`] = r.err[`${S} palm`] = r.err[`${S} fingers`] = null; continue; }
      const sc = (p: number[]) => (handW ? p : [p[0] * m.width, p[1] * m.height, p[2] * m.width]);
      const pts = (handW ?? hand).map(sc) as Vec3[];
      const hd = dirAv(`${side}Hand`, `${side}MiddleProximal`);
      r.err[`${S} hand dir`] = hd ? angleDeg(hd, mpToThree(sub3(pts[9], pts[0]))) : null;
      const w0 = this.wpos(`${side}Hand`), wi = this.wpos(`${side}IndexProximal`), wl = this.wpos(`${side}LittleProximal`);
      if (w0 && wi && wl) {
        const a = wi.sub(w0), b = wl.sub(w0);
        const nAv = side === "right" ? new THREE.Vector3().crossVectors(a, b) : new THREE.Vector3().crossVectors(b, a);
        r.err[`${S} palm`] = angleDeg(nAv.toArray(), mpToThree(palmNormal(pts, side)));
      }
      // fingers: mean angle over the 15 finger segments (positions of the next joint; the tip uses the distal bone direction)
      let sum = 0, cnt = 0;
      for (const fg of FINGER_BONES) {
        const lm = FINGER_LM[fg], segs = segNames(fg);
        for (let k = 0; k < 2; k++) {
          const d = dirAv(boneName(side, fg, segs[k]), boneName(side, fg, segs[k + 1]));
          if (d) { sum += angleDeg(d, mpToThree(sub3(pts[lm[k + 1]], pts[lm[k]]))); cnt++; }
        }
      }
      r.err[`${S} fingers`] = cnt ? sum / cnt : null;
    }
    for (const [k, v] of Object.entries(r.err)) {
      const limit = k.endsWith("fingers") ? RETARGET_THRESHOLD_DEG * 0.75 : RETARGET_THRESHOLD_DEG;
      if (v !== null && v > limit) r.retarget.push(`${k} ${Math.round(v)}°`);
    }
  }

  // ---------------------------------------------------------------- rendering
  render(closeupLabels?: (rects: { side: Side; x: number; y: number; size: number }[]) => void) {
    const { renderer, width: w, height: h } = this;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.render(this.scene, this.camera);
    if (!this.opts.closeup || !this.vrm) return;
    const box = Math.round(Math.min(w * 0.46, h * 0.34)), pad = Math.round(w * 0.02), labelPad = 26;
    const rects: { side: Side; x: number; y: number; size: number }[] = [];
    // the avatar's right hand appears on the image left, like the subject's
    for (const [side, x] of [["right", pad], ["left", w - box - pad]] as [Side, number][]) {
      const yTop = h - box - pad - labelPad;
      rects.push({ side, x, y: yTop, size: box });
      const handPos = this.wpos(`${side}Hand`), mid = this.wpos(`${side}MiddleProximal`);
      if (!handPos || !mid) continue;
      const target = handPos.clone().lerp(mid, 1.0);
      this.closeCam.position.set(target.x, target.y + 0.02, target.z + 0.4);
      this.closeCam.lookAt(target);
      this.closeCam.aspect = 1;
      this.closeCam.updateProjectionMatrix();
      renderer.setScissorTest(true);
      const glY = h - yTop - box; // WebGL viewport origin is bottom-left
      renderer.setScissor(x, glY, box, box);
      renderer.setViewport(x, glY, box, box);
      renderer.setClearColor(0x0a0c10, 1);
      renderer.clear();
      const bg = this.scene.background;
      this.scene.background = new THREE.Color(0x0a0c10);
      renderer.render(this.scene, this.closeCam);
      this.scene.background = bg;
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    closeupLabels?.(rects);
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Rotation whose x axis is `x` and y axis is `y` (orthogonalised), or null if degenerate. */
function basisQuat(x: THREE.Vector3, y: THREE.Vector3): THREE.Quaternion | null {
  const X = x.clone().normalize();
  const Y = y.clone().sub(X.clone().multiplyScalar(y.dot(X)));
  if (Y.lengthSq() < 1e-10) return null;
  Y.normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  return new THREE.Quaternion().setFromRotationMatrix(_m.makeBasis(X, Y, Z));
}

/** Rotation taking (a1, b1) to (a2, b2): a exactly, b as close as possible. */
function twoAxisQuat(a1: THREE.Vector3, b1: THREE.Vector3, a2: THREE.Vector3, b2: THREE.Vector3): THREE.Quaternion | null {
  const q1 = basisQuat(a1, b1), q2 = basisQuat(a2, b2);
  if (!q1 || !q2) return null;
  return q2.multiply(q1.invert());
}

