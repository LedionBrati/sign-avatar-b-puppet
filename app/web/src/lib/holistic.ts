// MediaPipe HolisticLandmarker (VIDEO mode) on the camera <video>, one detection per presented frame.
// Loaded lazily (the tasks-vision bundle + wasm + ~13 MB model) so the home screen stays light.
import type { HolisticFrame } from "@flux/core";
import type { HolisticLandmarker, HolisticLandmarkerResult } from "@mediapipe/tasks-vision";

declare const __MP_VERSION__: string;
export const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task";
export const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${__MP_VERSION__}/wasm`;

export interface Connections { hand: { start: number; end: number }[]; pose: { start: number; end: number }[] }

export interface Tracker {
  delegate: "GPU" | "CPU";
  connections: Connections;
  /** Run on one video frame; `t` must increase. Returns the first person's parts (UNMIRRORED image coords). */
  detect(video: HTMLVideoElement, t: number): HolisticFrame;
  close(): void;
}

/** GPU unless WebGL is a software rasterizer (headless Chrome's SwiftShader, llvmpipe), where the wasm CPU path is faster.
 *  Override with ?delegate=cpu|gpu in the hash. */
export function pickDelegate(): "GPU" | "CPU" {
  const forced = new URLSearchParams(location.hash.split("?")[1] ?? "").get("delegate");
  if (forced) return forced.toLowerCase() === "cpu" ? "CPU" : "GPU";
  try {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    if (!gl) return "CPU";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|software|basic render/i.test(r) ? "CPU" : "GPU";
  } catch { return "GPU"; }
}

export async function createTracker(prefer: "GPU" | "CPU" = pickDelegate()): Promise<Tracker> {
  const { FilesetResolver, HolisticLandmarker } = await import("@mediapipe/tasks-vision");
  const files = await FilesetResolver.forVisionTasks(WASM_URL);
  const make = (delegate: "GPU" | "CPU") => HolisticLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    minHandLandmarksConfidence: 0.5,
  });
  let delegate = prefer;
  let lm: HolisticLandmarker;
  try {
    lm = await make(prefer);
  } catch (e) {
    if (prefer === "CPU") throw e;
    delegate = "CPU";
    lm = await make("CPU");
  }
  let last = -1;
  return {
    delegate,
    connections: { hand: HolisticLandmarker.HAND_CONNECTIONS, pose: HolisticLandmarker.POSE_CONNECTIONS },
    detect(video, t) {
      const ts = Math.max(Math.round(t), last + 1);
      last = ts;
      const r: HolisticLandmarkerResult = lm.detectForVideo(video, ts);
      return {
        face: r.faceLandmarks[0] ?? null,
        pose: r.poseLandmarks[0] ?? null,
        leftHand: r.leftHandLandmarks[0] ?? null,
        rightHand: r.rightHandLandmarks[0] ?? null,
      };
    },
    close: () => lm.close(),
  };
}

/** Light overlay: upper-body pose lines and both hands. Drawn in image coords; the canvas is mirrored with the video by CSS. */
export function drawOverlay(ctx: CanvasRenderingContext2D, f: HolisticFrame, c: Connections) {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = "round";
  const lines = (pts: { x: number; y: number }[], conns: { start: number; end: number }[], max = Infinity) => {
    ctx.beginPath();
    for (const { start, end } of conns) {
      if (start > max || end > max) continue;
      const a = pts[start], b = pts[end];
      if (!a || !b) continue;
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
    }
    ctx.stroke();
  };
  if (f.pose) {
    ctx.strokeStyle = "rgb(255 255 255 / .35)";
    ctx.lineWidth = Math.max(2, w / 260);
    lines(f.pose, c.pose, 22); // shoulders, arms, hands; no legs
  }
  for (const [hand, col] of [[f.leftHand, "#ffffff"], [f.rightHand, "#cfd8ff"]] as const) {
    if (!hand) continue;
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(2.5, w / 200);
    lines(hand, c.hand);
    ctx.fillStyle = "#1f3fd6";
    for (const p of hand) { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, Math.max(2.5, w / 180), 0, Math.PI * 2); ctx.fill(); }
  }
}
