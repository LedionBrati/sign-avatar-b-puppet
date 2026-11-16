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
//    hand with palm normal, forearm taking the hand's roll, every finger joint with swing, so spread is kept).
//
// Two ways to play a motion:
//  - bake() + showAt()/showFrame() (default): every frame is solved once, the rotations are cleaned over the
//    whole clip (src/track.ts: tracker glitches out, dropouts bridged, light zero-phase smoothing) and played
//    back interpolated between frames, with hair/cloth physics. What the viewer and render.mjs use.
//  - applyFrame() (raw, viewer `smooth=0`, render `--raw`): each frame solved and shown as tracked.
//
// Coordinates: MediaPipe is x image-right, y down, z away from the camera. The avatar faces the camera
// (+Z toward the camera, y up), so subject-left = image-right = avatar-left = +X: a point maps to (x, -y, -z).

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from "@pixiv/three-vrm";
import * as Kalidokit from "kalidokit";
import type { Motion, MotionFrame, Vec3 } from "./motion";
import { angleDeg, mirrorFrame, mpToThree, palmNormal, sub3 } from "./geom";
import { cleanQuatChannel, cleanScalarChannel, DEFAULT_CLEAN, framePos, linkedSpikes, twistAbout, type ChannelParams, type CleanStats, type QuatChannel } from "./track";
import { AvatarHand, buildSegmentation, fingerBones, mixamoTips, vrmFromGltf } from "./avatar";
import { FINGERS, RELAXED_DEG, countOverlaps, countViolations, dirToWorld, fk, palmFrameRobust, separateFingers, smoothSequence, solveHand, thumbPlaneNormal, type HandAngles, type PalmFrame, type V3 } from "./hand";

/**
 * direct: aim every bone at the landmarks (fingers copy the tracker, noise and impossible angles included).
 * anatomic: body and wrist as direct; fingers through src/hand.ts (joint limits, IK to the fingertips, no
 * finger overlap, one-euro smoothing). The default for the realistic avatar.
 * kalidokit: the GSL repo's approach, for comparison (assumes a T-pose model such as the VRM sample).
 */
export type Solver = "kalidokit" | "direct" | "anatomic";
/** render passes: the picture, depth (white = near), view-space normals, and per-finger colours */
export type Pass = "rgb" | "depth" | "normal" | "seg";

/**
 * Clean-up per bone group (src/track.ts): the fastest a joint can plausibly turn (anything faster that comes
 * straight back is a tracker glitch) and a small zero-phase Gaussian. Fingers get the most room: handshape
 * changes are the fastest real motion in signing.
 */
export type BoneGroup = "torso" | "head" | "arm" | "twist" | "hand" | "finger";
export const CHANNEL_PARAMS: Record<BoneGroup, ChannelParams> = {
  torso: { maxSpeedDegS: 400, sigmaS: 0.04 },
  head: { maxSpeedDegS: 600, sigmaS: 0.04 },
  arm: { maxSpeedDegS: 1000, sigmaS: 0.025 },
  twist: { maxSpeedDegS: 1000, sigmaS: 0.025 },
  hand: { maxSpeedDegS: 1000, sigmaS: 0.025 },
  finger: { maxSpeedDegS: 1500, sigmaS: 0.025 },
};

const EXPRESSIONS = ["aa", "ee", "ih", "oh", "ou", "blinkLeft", "blinkRight", "blink"];

/** A motion solved once into bone rotations and cleaned (bake), ready to play at any time between frames. */
export interface BakedTrack {
  n: number;
  fps: number;
  solver: Solver;
  /** one entry per driven bone; the forearm keeps its roll (twist) separately, it is tracked with the hand */
  bones: { node: THREE.Object3D; q: Float32Array; twist: Float32Array | null }[];
  expressions: { name: string; v: Float32Array }[];
  browUp: Float32Array;
  browDown: Float32Array;
  /** per frame: tracking and retargeting report of the cleaned pose */
  reports: RetargetReport[];
  /** what the clean-up changed, per bone group (frames summed over the group's bones) */
  stats: Record<BoneGroup, CleanStats>;
}

/** forward steps longer than this (seconds) restart the hair/cloth simulation instead of integrating */
const SPRING_MAX_STEP_S = 0.25;
const SPRING_SETTLE_S = 0.6;
const SPRING_SUBSTEP_S = 1 / 60;
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();

export interface PuppetOptions {
  solver?: Solver;
  /** black top, skin-tone hands, dark wall (README §6.4) */
  mannequin?: boolean;
  /** render hand close-up insets */
  closeup?: boolean;
  background?: string;
  /** an image behind the avatar instead of the flat background colour (URL), e.g. assets/avatar/wall-plate.jpg */
  backgroundImage?: string;
  /** soft image-based lighting, tone mapping and target-photo framing (on for non-VRM avatars such as signer.glb) */
  realistic?: boolean;
  /** passes drawn side by side, left to right, each `width` wide (default ["rgb"]) */
  passes?: Pass[];
  /** cheap shading for software WebGL: Lambert + hemisphere light, no environment map (realistic avatar only) */
  lite?: boolean;
  /** WebGL multisampling (default true). Off is faster on software WebGL. */
  antialias?: boolean;
}

export interface RetargetReport {
  frame: number;
  /** parts the tracker did not deliver (tracking failures) */
  tracking: string[];
  /** bones whose avatar direction differs from the landmarks by more than the threshold (retargeting failures) */
  retarget: string[];
  /** degrees between avatar bone and tracked bone; null when the part was not tracked */
  err: Record<string, number | null>;
  /** per hand: finger joints of the shown avatar hand outside src/hand.ts LIMITS, and overlapping neighbour fingers */
  limits?: { L: number; R: number; overlapsL: number; overlapsR: number };
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

  /** true for a plain glTF avatar (signer.glb): A-pose rest, realistic look */
  isGltfAvatar = false;
  private lights: THREE.Light[] = [];
  private hands: Partial<Record<Side, AvatarHand>> = {};
  private segMaterial: THREE.Material | null = null;
  private passMats: Partial<Record<Pass, THREE.Material>> = {};

  constructor(public canvas: HTMLCanvasElement, public width: number, public height: number, opts: PuppetOptions = {}) {
    this.opts = {
      solver: opts.solver ?? "direct", mannequin: opts.mannequin ?? false, closeup: opts.closeup ?? false,
      background: opts.background ?? (opts.mannequin ? "#2b2b2f" : "#1d2026"), realistic: opts.realistic ?? false,
      passes: opts.passes?.length ? opts.passes : ["rgb"], antialias: opts.antialias ?? true, lite: opts.lite ?? false,
      backgroundImage: opts.backgroundImage ?? "",
    };
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.opts.antialias, preserveDrawingBuffer: true, alpha: false });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width * this.opts.passes.length, height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(this.opts.background);
    this.camera = new THREE.PerspectiveCamera(24, width / height, 0.05, 20);
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(0.6, 1.6, 2.0);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8); fill.position.set(-1.2, 1.0, 1.5);
    this.lights = [key, fill, new THREE.AmbientLight(0xffffff, 0.9)];
    this.scene.add(...this.lights);
  }

  /** Load a .vrm, or a glTF/GLB with a Mixamo-named skeleton (the realistic signer avatar). */
  async load(url: string): Promise<VRM> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    let vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      vrm = vrmFromGltf(gltf);
      this.isGltfAvatar = true;
      this.opts.realistic = true;
    } else {
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm); // VRM0 models face -Z; turn them to face the camera like VRM1
    }
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    if (vrm.springBoneManager) vrm.springBoneManager.reset();
    this.scene.add(vrm.scene);
    this.vrm = vrm;
    if (this.opts.realistic) this.applyRealisticLook();
    if (this.opts.mannequin) this.applyMannequin();
    if (this.opts.backgroundImage) {
      // a photo of the wall fills the frame (stretched to the canvas; use a plate with the canvas's aspect ratio)
      const tex = await new THREE.TextureLoader().loadAsync(this.opts.backgroundImage);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = tex;
    }
    for (const s of SIDES) {
      try { this.hands[s] = new AvatarHand(vrm, s, this.isGltfAvatar ? mixamoTips(vrm.scene, s) : {}); } catch { /* no finger bones */ }
    }
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

  /**
   * Soft, photo-like light for the realistic avatar: a room environment map (image-based light, no hard edges),
   * a large soft key from the upper right, neutral tone mapping, and the target photo's dark grey wall.
   */
  private applyRealisticLook() {
    const r = this.renderer;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    this.scene.remove(...this.lights);
    const key = new THREE.DirectionalLight(0xfff4ea, 1.6); key.position.set(-0.8, 2.2, 2.4); // camera-left, like the photo
    const fill = new THREE.DirectionalLight(0xeaf0ff, 0.45); fill.position.set(1.4, 1.2, 1.8);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5); rim.position.set(0.3, 1.8, -2.0);
    this.lights = [key, fill, rim];
    this.scene.add(...this.lights);
    if (this.opts.background === "#1d2026" || this.opts.background === "#2b2b2f") this.opts.background = "#33363a";
    this.scene.background = new THREE.Color(this.opts.background);
    this.vrm!.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
        if (!m.isMeshStandardMaterial) continue;
        const n = m.name.toLowerCase();
        m.metalness = 0;
        if (n === "top") m.roughness = 0.85;
        else if (n === "skin") m.roughness = 0.55;
        // the MakeHuman bob texture is light brown; the target has dark brown hair
        else if (n === "hair") { m.color.setRGB(0.22, 0.15, 0.11, THREE.SRGBColorSpace); m.roughness = 0.6; m.alphaTest = 0.35; m.transparent = false; m.side = THREE.DoubleSide; }
        else if (/brow|lash/.test(n)) { m.color.setRGB(0.25, 0.18, 0.14, THREE.SRGBColorSpace); m.alphaTest = 0.3; m.transparent = false; m.side = THREE.DoubleSide; }
      }
    });
    if (this.opts.lite) {
      // software WebGL: Lambert shading and a hemisphere light instead of PBR + environment map (much cheaper per pixel)
      this.scene.environment = null;
      const hemi = new THREE.HemisphereLight(0xf4f1ee, 0x3a3836, 1.6);
      this.lights.push(hemi);
      this.scene.add(hemi);
      this.vrm!.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const conv = (m: THREE.Material) => {
          const s = m as THREE.MeshStandardMaterial;
          if (!s.isMeshStandardMaterial) return m;
          return new THREE.MeshLambertMaterial({ name: s.name, color: s.color, map: s.map, alphaTest: s.alphaTest, side: s.side, transparent: s.transparent });
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(conv) : conv(mesh.material);
      });
    }
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
    let top = head.y + (head.y - hips.y) * 0.62; // head top (hair) plus a little air
    let bottom = hips.y - (head.y - hips.y) * 0.25; // below the waist, so hands resting on the lap stay in frame
    if (this.isGltfAvatar) {
      // assets/avatar/avatar-main.jpg: hair top 19.7% from the top, chin at 46.7%, the frame ends at the hips
      const box = new THREE.Box3();
      this.vrm!.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && /bob|hair/i.test(o.name + ((o as THREE.Mesh).material as THREE.Material).name)) box.expandByObject(o); });
      const hairTop = box.isEmpty() ? head.y + 0.21 : box.max.y;
      const chin = head.y - 0.01; // the neck/head joint sits about at the jaw line
      const span = (hairTop - chin) / (0.467 - 0.197);
      top = hairTop + 0.197 * span;
      bottom = top - span;
    }
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
    if (this.isGltfAvatar) {
      // A-pose rest: aim the arms instead (same pose as the VRM's: upper arm 72 degrees down, elbow a little bent)
      for (const s of SIDES) {
        const x = s === "left" ? 1 : -1;
        this.aim(`${s}UpperArm`, `${s}LowerArm`, new THREE.Vector3(0.315 * x, -0.949, 0.02));
        this.aim(`${s}LowerArm`, `${s}Hand`, new THREE.Vector3(0.2 * x, -0.95, 0.24));
        this.aim(`${s}Hand`, `${s}MiddleProximal`, new THREE.Vector3(0.1 * x, -0.97, 0.2));
      }
    } else {
      const down = 1.25;
      this.node("leftUpperArm")?.rotation.set(0, 0, -down);
      this.node("rightUpperArm")?.rotation.set(0, 0, down);
      this.node("leftLowerArm")?.rotation.set(0, -0.15, 0);
      this.node("rightLowerArm")?.rotation.set(0, 0.15, 0);
    }
    for (const s of SIDES) this.relaxFingers(s);
  }

  private relaxFingers(side: Side) {
    if (this.opts.solver === "anatomic" || this.isGltfAvatar) {
      const relaxed = Object.fromEntries(FINGERS.map((f) => [f, RELAXED_DEG[f].map((v) => (v * Math.PI) / 180)])) as HandAngles;
      this.poseFingers(side, relaxed);
      return;
    }
    const sign = side === "left" ? -1 : 1; // VRM1: curling toward the palm is -Z for the left hand, +Z for the right
    for (const f of FINGER_BONES) {
      if (f === "Thumb") continue;
      for (const seg of segNames(f)) this.node(boneName(side, f, seg))?.rotation.set(0, 0, sign * 0.25);
    }
  }

  /**
   * Raw mode: solve and show one frame as tracked, no clean-up, no physics (viewer `smooth=0`, render `--raw`).
   * Returns tracking and retargeting problems for it.
   */
  applyFrame(f: MotionFrame | null, m: Motion): RetargetReport {
    const report: RetargetReport = { frame: f?.i ?? -1, tracking: this.solveFrame(f, m), retarget: [], err: {} };
    this.springFrame = null;
    this.finish();
    if (f) this.measure(f, m, report);
    return report;
  }

  /** Solve one frame into the normalized bones and expression values. Returns the parts the tracker missed. */
  private solveFrame(f: MotionFrame | null, m: Motion): string[] {
    const tracking: string[] = [];
    this.restPose();
    this.resetExpressions();
    if (!f) { tracking.push("no frame"); return tracking; }
    if (!f.pose || !f.poseWorld) tracking.push("pose");
    if (!f.leftHand) tracking.push("L hand");
    if (!f.rightHand) tracking.push("R hand");
    if (!f.face) tracking.push("face");
    this.solveHead(f, m);
    if (this.opts.solver === "kalidokit") this.solveKalidokit(f, m);
    else this.solveDirect(f, m);
    this.solveExpressions(f, m);
    return tracking;
  }

  private finish() {
    this.vrm!.update(0); // normalized -> raw bones, constraints, expressions (spring bones get dt = 0)
    this.applyBrowMorphs();
    this.vrm!.scene.updateMatrixWorld(true);
  }

  // ---------------------------------------------------------------- baked, cleaned playback
  /** baked track of the current motion (null until bake) */
  track: BakedTrack | null = null;
  /** track position (frames) the hair/cloth simulation was last stepped to; null = needs a restart */
  private springFrame: number | null = null;

  /** Which parts of a frame the solver actually had, i.e. which bone groups are tracked (not rest fallback). */
  private tracked(f: MotionFrame) {
    const torso = !!(f.pose && f.poseWorld);
    const arm = (side: Side) => {
      if (!torso) return false;
      if (this.opts.solver === "kalidokit") return true; // kalidokit rigs the arms whenever there is a pose
      const [el, wr] = side === "left" ? [13, 15] : [14, 16];
      return Math.min(f.pose![el][3] ?? 1, f.pose![wr][3] ?? 1) >= 0.3; // same test as solveDirect
    };
    const hand = (side: Side) => arm(side) && !!(side === "left" ? f.leftHand : f.rightHand);
    const bs = f.faceBlendshapes;
    return {
      torso, head: !!(f.face || f.poseWorld), face: !!((bs && Object.keys(bs).length) || f.face),
      arm: { left: arm("left"), right: arm("right") }, hand: { left: hand("left"), right: hand("right") },
    };
  }

  /** The bones the solvers drive, with their group and side. */
  private drivenBones(): { name: VRMHumanBoneName; group: BoneGroup; side: Side | null }[] {
    const out: { name: VRMHumanBoneName; group: BoneGroup; side: Side | null }[] = [];
    for (const name of ["spine", "chest", "upperChest"] as VRMHumanBoneName[]) out.push({ name, group: "torso", side: null });
    for (const name of ["neck", "head"] as VRMHumanBoneName[]) out.push({ name, group: "head", side: null });
    for (const side of SIDES) {
      out.push({ name: `${side}UpperArm`, group: "arm", side }, { name: `${side}LowerArm`, group: "arm", side }, { name: `${side}Hand`, group: "hand", side });
      for (const fg of FINGER_BONES) for (const seg of segNames(fg)) out.push({ name: boneName(side, fg, seg), group: "finger", side });
    }
    return out.filter((b) => this.node(b.name));
  }

  /**
   * Solve every frame once, then clean the rotations over the whole clip (src/track.ts): tracker glitches out,
   * dropouts bridged or eased, light zero-phase smoothing. Signs keep their timing (nothing lags) and held
   * handshapes stay exact. Needed before showAt / showFrame.
   */
  bake(m: Motion): BakedTrack {
    const vrm = this.vrm!;
    const n = m.frames.length, fps = m.fps;
    if (this.opts.solver === "anatomic") this.precomputeHands(m);
    else this.handPre = null;
    const bones = this.drivenBones().map((b) => {
      const node = this.node(b.name)!;
      const forearm = b.name === "leftLowerArm" || b.name === "rightLowerArm";
      const child = forearm ? this.node(`${b.side}Hand` as VRMHumanBoneName) : null;
      // anatomic fingers are already smoothed (one-euro, zero-phase) and limit-checked per joint angle: no second blur
      const params = (group: BoneGroup) => (group === "finger" && this.opts.solver === "anatomic" ? { ...CHANNEL_PARAMS.finger, sigmaS: 0 } : CHANNEL_PARAMS[group]);
      const channel = (name: string, group: BoneGroup): QuatChannel => ({ name, q: new Float32Array(4 * n), valid: new Uint8Array(n), params: params(group) });
      return {
        ...b, node,
        rot: channel(b.name, b.group),
        // the forearm's roll is tracked with the hand, its direction with the arm: two channels
        twist: forearm && child ? channel(`${b.name} roll`, "twist") : null,
        // roll axis = toward the hand, in the forearm's own rest frame
        axis: forearm && child ? child.position.clone().normalize() : null,
      };
    });
    const scalar = (name: string) => ({ name, v: new Float32Array(n), valid: new Uint8Array(n) });
    const expressions = EXPRESSIONS.map(scalar);
    const browUp = scalar("browUp"), browDown = scalar("browDown");
    const tracking: string[][] = [];
    const swing = new THREE.Quaternion(), roll = new THREE.Quaternion();

    for (let i = 0; i < n; i++) {
      const f = m.frames[i];
      tracking.push(this.solveFrame(f, m));
      const ok = this.tracked(f);
      for (const b of bones) {
        const valid = b.group === "torso" ? ok.torso : b.group === "head" ? ok.head : b.group === "arm" ? ok.arm[b.side!] : ok.hand[b.side!];
        if (b.twist && b.axis) {
          roll.copy(twistAbout(b.node.quaternion, b.axis)); // q = swing * roll
          swing.copy(b.node.quaternion).multiply(roll.clone().invert());
          swing.toArray(b.rot.q as unknown as number[], 4 * i);
          b.rot.valid[i] = ok.arm[b.side!] ? 1 : 0;
          roll.toArray(b.twist.q as unknown as number[], 4 * i);
          b.twist.valid[i] = ok.hand[b.side!] ? 1 : 0;
        } else {
          b.node.quaternion.toArray(b.rot.q as unknown as number[], 4 * i);
          b.rot.valid[i] = valid ? 1 : 0;
        }
      }
      const em = vrm.expressionManager;
      for (const e of expressions) { e.v[i] = em?.getValue(e.name) ?? 0; e.valid[i] = ok.face ? 1 : 0; }
      browUp.v[i] = this.browUp; browDown.v[i] = this.browDown;
      browUp.valid[i] = browDown.valid[i] = ok.face ? 1 : 0;
    }

    const zero = (): CleanStats => ({ spikeFrames: 0, bridgedFrames: 0, fadedFrames: 0 });
    const stats: Record<BoneGroup, CleanStats> = { torso: zero(), head: zero(), arm: zero(), twist: zero(), hand: zero(), finger: zero() };
    const add = (g: BoneGroup, s: CleanStats) => { stats[g].spikeFrames += s.spikeFrames; stats[g].bridgedFrames += s.bridgedFrames; stats[g].fadedFrames += s.fadedFrames; };
    // Bones that move as one are repaired together where the chain glitches (linkedSpikes): torso, head, each
    // arm (upper arm + forearm direction), each hand (forearm roll + wrist, then the 15 finger bones). Otherwise
    // a hand read inside out could get its fingers repaired but not its wrist, and they would point the wrong
    // way. On Judy a misread hand flags 10-14 hand bones at once, a single bad finger 1-2: hence 5 votes.
    const chains = new Map<string, { ch: QuatChannel; group: BoneGroup; parent: boolean }[]>();
    const link = (key: string, ch: QuatChannel, group: BoneGroup, parent: boolean) => {
      if (!chains.has(key)) chains.set(key, []);
      chains.get(key)!.push({ ch, group, parent });
    };
    for (const b of bones) {
      if (b.group === "torso" || b.group === "head") link(b.group, b.rot, b.group, b.name === "spine" || b.name === "neck");
      else if (b.group === "arm") link(`${b.side} arm`, b.rot, b.group, b.name.endsWith("UpperArm"));
      else link(`${b.side} hand`, b.rot, b.group, b.group === "hand");
      if (b.twist) link(`${b.side} hand`, b.twist, "twist", true);
    }
    for (const [key, chain] of chains) {
      chain.sort((x, y) => Number(y.parent) - Number(x.parent)); // parents first (stable)
      const rule = { parents: chain.filter((c) => c.parent).length, minVotes: key.endsWith("hand") ? 5 : chain.length };
      const spikes = linkedSpikes(chain.map((c) => c.ch), n, fps, rule, DEFAULT_CLEAN);
      chain.forEach(({ ch, group }, k) => add(group, cleanQuatChannel(ch, n, fps, DEFAULT_CLEAN, spikes[k])));
    }
    for (const s of [...expressions, browUp, browDown]) cleanScalarChannel(s, n, fps, DEFAULT_CLEAN);

    const track: BakedTrack = {
      n, fps, solver: this.opts.solver,
      bones: bones.map((b) => ({ node: b.node, q: b.rot.q, twist: b.twist?.q ?? null })),
      expressions: expressions.map(({ name, v }) => ({ name, v })),
      browUp: browUp.v, browDown: browDown.v, reports: [], stats,
    };
    this.track = track;
    // the report describes what is shown: the cleaned pose at every frame
    for (let i = 0; i < n; i++) {
      this.poseAt(i);
      this.finish();
      const report: RetargetReport = { frame: i, tracking: tracking[i], retarget: [], err: {} };
      this.measure(m.frames[i], m, report);
      track.reports.push(report);
    }
    this.springFrame = null;
    return track;
  }

  /** Set the normalized bones and expressions from the baked track at a fractional frame (no update). */
  private poseAt(frame: number) {
    const tr = this.track!;
    const { k, w } = framePos(tr.n, frame);
    const k1 = Math.min(tr.n - 1, k + 1);
    const arr = (a: Float32Array) => a as unknown as number[];
    this.vrm!.humanoid.resetNormalizedPose();
    for (const b of tr.bones) {
      _qa.fromArray(arr(b.q), 4 * k).slerp(_qb.fromArray(arr(b.q), 4 * k1), w);
      if (b.twist) _qa.multiply(_qc.fromArray(arr(b.twist), 4 * k).slerp(_qb.fromArray(arr(b.twist), 4 * k1), w));
      b.node.quaternion.copy(_qa);
    }
    const em = this.vrm!.expressionManager;
    const lerp = (v: Float32Array) => v[k] + (v[k1] - v[k]) * w;
    if (em) for (const e of tr.expressions) em.setValue(e.name, lerp(e.v));
    this.browUp = lerp(tr.browUp);
    this.browDown = lerp(tr.browDown);
  }

  /**
   * Show the baked track at a fractional frame (playback between frames) and step the hair/cloth physics.
   * Moving forward integrates the springs over the elapsed motion time; a jump back or a long jump forward
   * (a seek, a loop) restarts them and lets them settle on the new pose. Deterministic for a given call sequence.
   */
  showAt(frame: number): void {
    const vrm = this.vrm!, tr = this.track!;
    const at = Math.max(0, Math.min(tr.n - 1, frame));
    this.poseAt(at);
    const sb = vrm.springBoneManager;
    const stepS = this.springFrame === null ? -1 : (at - this.springFrame) / tr.fps;
    if (sb && (stepS < 0 || stepS > SPRING_MAX_STEP_S)) {
      vrm.update(0);
      sb.reset();
      for (let s = 0; s < Math.round(SPRING_SETTLE_S / SPRING_SUBSTEP_S); s++) vrm.update(SPRING_SUBSTEP_S);
    } else if (stepS > 0) {
      const steps = Math.max(1, Math.ceil(stepS / SPRING_SUBSTEP_S - 1e-9));
      for (let s = 0; s < steps; s++) vrm.update(stepS / steps);
    } else vrm.update(0);
    this.springFrame = at;
    this.applyBrowMorphs();
    vrm.scene.updateMatrixWorld(true);
  }

  /** Show baked frame i exactly (the offline render) and return its report. */
  showFrame(i: number): RetargetReport {
    const tr = this.track!;
    const k = Math.max(0, Math.min(tr.n - 1, Math.round(i)));
    this.showAt(k);
    return tr.reports[k];
  }

  private resetExpressions() {
    const em = this.vrm!.expressionManager;
    if (em) for (const n of EXPRESSIONS) em.setValue(n, 0);
    this.browUp = 0; this.browDown = 0;
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
      // forearm direction first; its roll (pronation/supination) comes from the hand below
      this.aim(`${side}LowerArm`, `${side}Hand`, fore);
      if (!H || !hand) continue;
      let palmN = v3(mpToThree(handW ? palmNormal(handW, side) : palmNormal(hand, side, [m.width, m.height, m.width])));
      if (this.opts.solver === "anatomic") {
        // the anatomic solver may decide the tracker flipped the palm (src/hand.ts palmFrameRobust): follow it
        const pts = this.handPoints(f, m, side);
        const R = pts ? palmFrameRobust(pts, side) : null;
        if (R) palmN = new THREE.Vector3(...R.n);
      }
      const restPalm = this.restPalmNormal(side);
      // hand: wrist -> middle knuckle, rolled by the palm normal. Always well defined: the palm normal is
      // perpendicular to that direction (it could line up with the forearm when the wrist bends, which made
      // the old forearm-first roll flip).
      this.aim(`${side}Hand`, `${side}MiddleProximal`, H(9).sub(H(0)), restPalm, palmN, 1);
      // a wrist cannot roll: move the hand's roll about the forearm axis into the forearm.
      // The hand's world orientation (and so every finger) is unchanged by this.
      this.moveRollToForearm(side);
      if (this.opts.solver === "anatomic") {
        // fingers from the anatomical hand solver: limited, IK-fitted, smoothed over the clip when baked
        const pre = this.handPre?.motion === m ? this.handPre[side][f.i] : undefined;
        const angles = pre !== undefined ? pre : this.solveHandFrame(f, m, side);
        if (angles) this.poseFingers(side, angles);
        continue;
      }
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

  /** forearm.q *= roll, hand.q = roll^-1 * hand.q, with roll = the hand's twist about the forearm axis */
  private moveRollToForearm(side: Side) {
    const fore = this.node(`${side}LowerArm`), hand = this.node(`${side}Hand`);
    if (!fore || !hand || hand.position.lengthSq() < 1e-12) return;
    const roll = twistAbout(hand.quaternion, hand.position.clone().normalize());
    fore.quaternion.multiply(roll);
    hand.quaternion.premultiply(roll.invert());
    fore.updateMatrixWorld(true);
  }

  // ---------------------------------------------------------------- anatomic hands (src/hand.ts)
  /** per-frame hand angles of the baked motion, solved and smoothed over the whole clip (anatomic solver) */
  private handPre: { motion: Motion; left: (HandAngles | null)[]; right: (HandAngles | null)[] } | null = null;

  /**
   * The 21 hand points of one frame in avatar axes (metres): motion v2 `hands3d` when present (already fitted
   * to an anatomical skeleton; its conf is often low only because the source was blurry, the hand is still a
   * possible hand), else the tracker's world hand landmarks, else the image landmarks scaled to pixels.
   * Fingers only use the hand's shape (wrist-relative), so hands3d and v1 points mix freely frame to frame.
   */
  handPoints(f: MotionFrame, m: Motion, side: Side): V3[] | null {
    const h3 = f.hands3d?.[side];
    if (h3?.joints?.length === 21) return h3.joints.map((p) => mpToThree(p) as V3);
    const hand = side === "left" ? f.leftHand : f.rightHand;
    const handW = side === "left" ? f.leftHandWorld : f.rightHandWorld;
    if (handW) return handW.map((p) => mpToThree(p) as V3);
    if (hand) return hand.map((p) => mpToThree([p[0] * m.width, p[1] * m.height, p[2] * m.width]) as V3);
    return null;
  }

  private solveHandFrame(f: MotionFrame, m: Motion, side: Side): HandAngles | null {
    const ah = this.hands[side];
    const pts = this.handPoints(f, m, side);
    if (!ah || !pts) return null;
    return solveHand(pts, side, ah.geom)?.angles ?? null;
  }

  /** Solve both hands over the whole clip, then smooth (zero-phase one-euro) and re-check overlaps. */
  private precomputeHands(m: Motion) {
    const out = { motion: m, left: [] as (HandAngles | null)[], right: [] as (HandAngles | null)[] };
    for (const side of SIDES) {
      const raw = m.frames.map((f) => this.solveHandFrame(f, m, side));
      const ah = this.hands[side];
      out[side] = smoothSequence(raw, m.fps).map((a) => { if (a && ah) separateFingers(ah.geom, a, 0.0065); return a; });
    }
    this.handPre = out;
  }

  /** current palm frame of the avatar's hand (world): its rest palm frame carried by the hand bone */
  private currentPalm(side: Side): PalmFrame | null {
    const ah = this.hands[side], hand = this.node(`${side}Hand`);
    if (!ah || !hand) return null;
    hand.updateWorldMatrix(true, false);
    const q = hand.getWorldQuaternion(new THREE.Quaternion());
    const rot = (v: V3) => new THREE.Vector3(v[0], v[1], v[2]).applyQuaternion(q).toArray() as V3;
    return { o: hand.getWorldPosition(new THREE.Vector3()).toArray() as V3, x: rot(ah.rest.x), y: rot(ah.rest.y), n: rot(ah.rest.n) };
  }

  /** Pose the 15 finger bones of a hand from joint angles (forward kinematics in the avatar's own palm frame). */
  private poseFingers(side: Side, angles: HandAngles) {
    const ah = this.hands[side];
    const F = this.currentPalm(side);
    if (!ah || !F) return;
    for (const f of FINGERS) {
      const bones = fingerBones(side, f);
      if (!bones.every((b) => this.node(b))) continue;
      const { dirs } = fk(ah.geom, f, angles[f]);
      for (let k = 0; k < 3; k++) {
        const child = k < 2 ? bones[k + 1] : ah.tipOffset[f];
        const dW = new THREE.Vector3(...dirToWorld(F, dirs[k]));
        if (f === "thumb" && k === 0) {
          // the thumb also turns about its own axis as it opposes: carry its bend plane along
          const restN = new THREE.Vector3(...dirToWorld(ah.rest, ah.thumbPlaneNormal));
          const n = new THREE.Vector3(...dirToWorld(F, thumbPlaneNormal(dirs[0])));
          this.aim(bones[k], child, dW, restN, n, 1);
        } else this.aim(bones[k], child, dW);
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
      // anatomy of the hand as shown: joints outside the limits, neighbour fingers inside each other
      const ah = this.hands[side];
      if (ah) {
        const shown = ah.points();
        r.limits ??= { L: 0, R: 0, overlapsL: 0, overlapsR: 0 };
        r.limits[S] = countViolations(shown, side).count;
        r.limits[`overlaps${S}`] = countOverlaps(shown, side);
      }
    }
    for (const [k, v] of Object.entries(r.err)) {
      const limit = k.endsWith("fingers") ? RETARGET_THRESHOLD_DEG * 0.75 : RETARGET_THRESHOLD_DEG;
      if (v !== null && v > limit) r.retarget.push(`${k} ${Math.round(v)}°`);
    }
  }

  // ---------------------------------------------------------------- rendering
  /**
   * One pass from the same camera. depth: 8-bit, white = near, over a 1.2 m slab around the avatar (so the
   * hands in front of the body get most of the range), black = background. normal: view-space normals as
   * RGB = n * 0.5 + 0.5, background (128, 128, 255). seg: flat colours per finger (avatar.ts SEG_COLORS).
   */
  private renderPass(p: Pass) {
    const { renderer, scene, camera } = this;
    if (p === "rgb") { renderer.render(scene, camera); return; }
    const saved = { bg: scene.background, tm: renderer.toneMapping, cs: renderer.outputColorSpace, near: camera.near, far: camera.far, ov: scene.overrideMaterial };
    renderer.toneMapping = THREE.NoToneMapping;
    if (p === "depth") {
      const d = camera.position.distanceTo(this.wpos("upperChest") ?? this.wpos("hips") ?? new THREE.Vector3());
      camera.near = Math.max(0.05, d - 0.75); camera.far = d + 0.45;
      camera.updateProjectionMatrix();
      this.passMats.depth ??= new THREE.MeshDepthMaterial();
      scene.overrideMaterial = this.passMats.depth;
      scene.background = new THREE.Color(0, 0, 0);
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    } else if (p === "normal") {
      this.passMats.normal ??= new THREE.MeshNormalMaterial();
      scene.overrideMaterial = this.passMats.normal;
      scene.background = new THREE.Color(0.5, 0.5, 1.0);
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    } else {
      this.segMaterial ??= buildSegmentation(this.vrm!);
      scene.overrideMaterial = this.segMaterial;
      scene.background = new THREE.Color(0, 0, 0);
    }
    renderer.render(scene, camera);
    scene.background = saved.bg; scene.overrideMaterial = saved.ov;
    renderer.toneMapping = saved.tm; renderer.outputColorSpace = saved.cs;
    if (camera.near !== saved.near || camera.far !== saved.far) { camera.near = saved.near; camera.far = saved.far; camera.updateProjectionMatrix(); }
  }

  render(closeupLabels?: (rects: { side: Side; x: number; y: number; size: number }[]) => void) {
    const { renderer, width: w, height: h } = this;
    const passes = this.opts.passes;
    renderer.setScissorTest(passes.length > 1);
    passes.forEach((p, k) => {
      renderer.setViewport(k * w, 0, w, h);
      renderer.setScissor(k * w, 0, w, h);
      this.renderPass(p);
    });
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    if (!this.opts.closeup || !this.vrm || passes[0] !== "rgb") return;
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

