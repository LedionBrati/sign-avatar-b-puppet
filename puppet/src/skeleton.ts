// 2D debug view of one motion frame on a canvas: pose bones, both hands (one colour per finger),
// face contour, palm-normal arrows, "lost" labels for missing parts, frame number and time.
// Colour convention: subject's RIGHT side = orange, subject's LEFT side = cyan.
import type { Motion, MotionFrame, Vec3, Vec4 } from "./motion";
import { palmCenter, palmNormal } from "./geom";

export interface SkeletonOptions {
  /** draw zoomed insets of both hands at the bottom */
  closeup?: boolean;
  /** title, frame/time, lost-part labels (default true) */
  labels?: boolean;
  title?: string;
  background?: string;
  /** extra lines drawn under the title (e.g. retargeting warnings) */
  notes?: { text: string; color?: string }[];
}

export const COLORS = {
  right: "#ff9a3c",
  left: "#38c8ff",
  torso: "#d8d8d8",
  legs: "#666",
  face: "#9aa3ad",
  lost: "#ff4d4d",
  fingers: { thumb: "#ff5a5a", index: "#ffd23f", middle: "#4dde7a", ring: "#4db8ff", pinky: "#c77dff" } as Record<string, string>,
};

const POSE_EDGES: [number, number, "left" | "right" | "torso" | "legs" | "face"][] = [
  [11, 12, "torso"], [11, 23, "torso"], [12, 24, "torso"], [23, 24, "torso"],
  [11, 13, "left"], [13, 15, "left"], [15, 17, "left"], [15, 19, "left"], [15, 21, "left"], [17, 19, "left"],
  [12, 14, "right"], [14, 16, "right"], [16, 18, "right"], [16, 20, "right"], [16, 22, "right"], [18, 20, "right"],
  [23, 25, "legs"], [25, 27, "legs"], [24, 26, "legs"], [26, 28, "legs"],
  [9, 10, "face"], [7, 3, "face"], [3, 2, "face"], [2, 1, "face"], [1, 0, "face"], [0, 4, "face"], [4, 5, "face"], [5, 6, "face"], [6, 8, "face"],
];

const FINGERS: [string, number[]][] = [
  ["thumb", [0, 1, 2, 3, 4]], ["index", [5, 6, 7, 8]], ["middle", [9, 10, 11, 12]], ["ring", [13, 14, 15, 16]], ["pinky", [17, 18, 19, 20]],
];
const PALM = [0, 5, 9, 13, 17, 0];

const FACE_LINES: number[][] = [
  // oval
  [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
  // lips outer / inner
  [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185, 61],
  [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191, 78],
  // eyes (subject's right = image left, then left)
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33],
  [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466, 263],
  // brows
  [70, 63, 105, 66, 107], [46, 53, 52, 65, 55],
  [300, 293, 334, 296, 336], [276, 283, 282, 295, 285],
  // nose bridge
  [168, 6, 197, 195, 5, 4],
];

interface Xf { ox: number; oy: number; s: number; W: number; H: number }
const px = (p: Vec3 | Vec4, x: Xf): [number, number] => [x.ox + p[0] * x.W * x.s, x.oy + p[1] * x.H * x.s];

function line(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number]) {
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
}
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = "#fff", size = 15, bg = "rgba(0,0,0,.55)") {
  ctx.font = `600 ${size}px system-ui, "Segoe UI", sans-serif`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = bg; ctx.fillRect(x - 4, y - size + 1, w + 8, size + 6);
  ctx.fillStyle = color; ctx.fillText(text, x, y + 2);
}

/** Palm normal in MediaPipe axes: from world points when present (true metres), else from scaled image points. */
export function framePalmNormal(f: MotionFrame, side: "left" | "right", m: Pick<Motion, "width" | "height">): Vec3 | null {
  const img = side === "left" ? f.leftHand : f.rightHand;
  const world = side === "left" ? f.leftHandWorld : f.rightHandWorld;
  if (world) return palmNormal(world, side);
  if (img) return palmNormal(img, side, [m.width, m.height, m.width]);
  return null;
}

function drawHand(ctx: CanvasRenderingContext2D, hand: Vec3[], x: Xf, width: number, dot: number) {
  ctx.lineWidth = width;
  ctx.strokeStyle = "rgba(255,255,255,.75)";
  for (let k = 0; k < PALM.length - 1; k++) line(ctx, px(hand[PALM[k]], x), px(hand[PALM[k + 1]], x));
  for (const [name, chain] of FINGERS) {
    ctx.strokeStyle = COLORS.fingers[name];
    for (let k = 0; k < chain.length - 1; k++) line(ctx, px(hand[chain[k]], x), px(hand[chain[k + 1]], x));
    ctx.fillStyle = COLORS.fingers[name];
    for (const j of chain) { const [a, b] = px(hand[j], x); ctx.beginPath(); ctx.arc(a, b, dot, 0, Math.PI * 2); ctx.fill(); }
  }
}

/** Arrow out of the palm. Length shows the in-image part; the disc shows toward (green) / away from (red) the camera. */
function drawPalmArrow(ctx: CanvasRenderingContext2D, hand: Vec3[], n: Vec3, x: Xf, len: number, sideColor: string) {
  const [cx, cy] = px(palmCenter(hand), x);
  const ex = cx + n[0] * len, ey = cy + n[1] * len;
  const toward = n[2] < 0;
  const r = 3 + Math.abs(n[2]) * len * 0.18;
  ctx.fillStyle = toward ? "rgba(70,230,120,.85)" : "rgba(255,80,80,.85)";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  if (!toward) { // a cross = arrow tail seen from behind
    ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5;
    line(ctx, [cx - r * 0.6, cy - r * 0.6], [cx + r * 0.6, cy + r * 0.6]); line(ctx, [cx - r * 0.6, cy + r * 0.6], [cx + r * 0.6, cy - r * 0.6]);
  } else { ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.5, r * 0.25), 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = sideColor; ctx.lineWidth = 3;
  line(ctx, [cx, cy], [ex, ey]);
  const a = Math.atan2(ey - cy, ex - cx), h = 9;
  if (Math.hypot(ex - cx, ey - cy) > 6) {
    ctx.fillStyle = sideColor; ctx.beginPath(); ctx.moveTo(ex, ey);
    ctx.lineTo(ex - h * Math.cos(a - 0.45), ey - h * Math.sin(a - 0.45)); ctx.lineTo(ex - h * Math.cos(a + 0.45), ey - h * Math.sin(a + 0.45)); ctx.fill();
  }
}

export function palmFacing(n: Vec3): string {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return n[2] < 0 ? "camera" : "away";
  if (ay >= ax) return n[1] < 0 ? "up" : "down";
  return n[0] < 0 ? "img-left" : "img-right";
}

export function drawSkeleton(ctx: CanvasRenderingContext2D, f: MotionFrame | null, m: Motion, w: number, h: number, opts: SkeletonOptions = {}) {
  const labels = opts.labels ?? true;
  ctx.save();
  ctx.fillStyle = opts.background ?? "#111317";
  ctx.fillRect(0, 0, w, h);
  const s = Math.min(w / m.width, h / m.height);
  const x: Xf = { s, W: m.width, H: m.height, ox: (w - m.width * s) / 2, oy: (h - m.height * s) / 2 };
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const lost: string[] = [];

  if (f) {
    // face
    if (f.face) {
      ctx.strokeStyle = COLORS.face; ctx.lineWidth = 1.3;
      for (const chain of FACE_LINES) {
        ctx.beginPath();
        chain.forEach((j, k) => { const [a, b] = px(f.face![j], x); if (k) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
        ctx.stroke();
      }
      if (f.face.length >= 478) {
        ctx.fillStyle = "#fff";
        for (const j of [468, 473]) { const [a, b] = px(f.face[j], x); ctx.beginPath(); ctx.arc(a, b, 2.2, 0, Math.PI * 2); ctx.fill(); }
      }
    } else lost.push("face lost");

    // pose
    if (f.pose) {
      const P = f.pose;
      for (const [a, b, kind] of POSE_EDGES) {
        if (kind === "face" && f.face) continue;
        const vis = Math.min(P[a][3] ?? 1, P[b][3] ?? 1);
        ctx.strokeStyle = kind === "left" ? COLORS.left : kind === "right" ? COLORS.right : kind === "legs" ? COLORS.legs : kind === "face" ? COLORS.face : COLORS.torso;
        ctx.globalAlpha = vis < 0.5 ? 0.3 : 1;
        ctx.lineWidth = kind === "face" ? 1.5 : 4;
        line(ctx, px(P[a], x), px(P[b], x));
      }
      ctx.globalAlpha = 1;
      for (let j = 0; j < 25; j++) {
        const [a, b] = px(P[j], x);
        const vis = P[j][3] ?? 1;
        ctx.fillStyle = j % 2 === 1 && j > 10 ? COLORS.left : j > 10 ? COLORS.right : COLORS.face;
        ctx.beginPath(); ctx.arc(a, b, j > 10 ? 4.5 : 2.5, 0, Math.PI * 2);
        if (vis < 0.5) { ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.5; ctx.stroke(); } else ctx.fill();
      }
      if (labels) { // side letters at the wrists so left/right can't be confused
        const [rx, ry] = px(P[16], x), [lx, ly] = px(P[15], x);
        label(ctx, "R", rx - 22, ry + 4, COLORS.right, 14);
        label(ctx, "L", lx + 10, ly + 4, COLORS.left, 14);
      }
    } else lost.push("pose lost");

    // hands
    for (const side of ["right", "left"] as const) {
      const hand = side === "left" ? f.leftHand : f.rightHand;
      if (!hand) { lost.push(`${side === "left" ? "L" : "R"} hand lost`); continue; }
      drawHand(ctx, hand, x, 2.5, 2.6);
      const n = framePalmNormal(f, side, m);
      if (n) drawPalmArrow(ctx, hand, n, x, 55, side === "left" ? COLORS.left : COLORS.right);
    }
  } else lost.push("no frame");

  // hand close-ups
  if (opts.closeup && f) {
    const box = Math.round(Math.min(w * 0.46, h * 0.34));
    const pad = Math.round(w * 0.02);
    const insets: ["right" | "left", number][] = [["right", pad], ["left", w - box - pad]]; // subject's right shows on the image left
    for (const [side, bx] of insets) {
      const by = h - box - pad - (labels ? 26 : 0);
      ctx.fillStyle = "rgba(10,12,16,.92)"; ctx.fillRect(bx, by, box, box);
      ctx.strokeStyle = side === "left" ? COLORS.left : COLORS.right; ctx.lineWidth = 2; ctx.strokeRect(bx, by, box, box);
      const hand = side === "left" ? f.leftHand : f.rightHand;
      const name = side === "left" ? "L hand" : "R hand";
      if (hand) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of hand) { x0 = Math.min(x0, p[0] * m.width); x1 = Math.max(x1, p[0] * m.width); y0 = Math.min(y0, p[1] * m.height); y1 = Math.max(y1, p[1] * m.height); }
        const span = Math.max(x1 - x0, y1 - y0) * 1.35 + 10;
        const zs = box / span;
        const zx: Xf = { s: zs, W: m.width, H: m.height, ox: bx + box / 2 - ((x0 + x1) / 2) * zs, oy: by + box / 2 - ((y0 + y1) / 2) * zs };
        ctx.save(); ctx.beginPath(); ctx.rect(bx, by, box, box); ctx.clip();
        drawHand(ctx, hand, zx, 4, 4.5);
        const n = framePalmNormal(f, side, m);
        if (n) drawPalmArrow(ctx, hand, n, zx, box * 0.3, side === "left" ? COLORS.left : COLORS.right);
        ctx.restore();
        if (labels && n) label(ctx, `${name} · palm → ${palmFacing(n)}`, bx + 6, by + 18, side === "left" ? COLORS.left : COLORS.right, 13);
        else if (labels) label(ctx, name, bx + 6, by + 18, side === "left" ? COLORS.left : COLORS.right, 13);
      } else {
        label(ctx, `${name} lost`, bx + box / 2 - 36, by + box / 2, COLORS.lost, 15);
      }
    }
  }

  if (labels) {
    let y = 22;
    if (opts.title) { label(ctx, opts.title, 8, y, "#e8e8e8", 15); y += 24; }
    for (const t of lost) { label(ctx, t, 8, y, COLORS.lost, 15); y += 24; }
    for (const n of opts.notes ?? []) { label(ctx, n.text, 8, y, n.color ?? "#ffd23f", 13); y += 21; }
    if (f) label(ctx, `frame ${f.i + 1}/${m.frames.length} · ${f.t.toFixed(2)} s`, 8, h - 8, "#cfd3da", 13);
  }
  ctx.restore();
  return { lost };
}
