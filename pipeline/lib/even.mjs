// Even out sign clips that came from different H3 Max Recast jobs.
//
// Why: every Recast job picks its own wall tone and its own zoom. Clips from one job match each
// other; clips from two jobs jump when they are joined (the wall changes colour, the head changes
// size and place). Measured on assets/demo/sentences/three-sentences-realtime.mp4: 2 jumps, the wall
// moves by up to 9 levels per channel and the head moves by about 4% of the frame height.
//
// How: measure each clip (wall colour in the top corners, her face from its skin pixels), then move
// every clip onto ONE shared target: a colour map first (wall and skin land on the target's), then
// a zoom + shift so the face has the target's size and place. ffmpeg only, no fal call.
// The motion and the hands are never changed, only their colour and their size on screen.

import { execFileSync } from "node:child_process";

const AW = 384;                 // analysis width in pixels (height follows the clip's aspect)
const SAMPLES = 16;             // frames measured per clip, spread over the whole clip
const LIMIT = { scale: [0.85, 1.18], gain: [0.85, 1.18] }; // never correct more than this

const sorted = (a) => Float64Array.from(a).sort();
const pct = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] : NaN);
const median = (a) => pct(sorted(a), 0.5);
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 4) => Number(v.toFixed(d));

export function probe(path) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=width,height,nb_read_packets", "-of", "csv=p=0", path]).toString().trim();
  const [w, h, n] = out.split(",").map(Number);
  return { w, h, frames: n };
}

/** SAMPLES frames spread over the clip, scaled to AW wide, as raw RGB buffers. */
function readSamples(path, { w, h, frames }) {
  const ah = Math.round((AW * h) / w / 2) * 2;
  const step = Math.max(1, Math.floor(frames / SAMPLES));
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", path,
    "-vf", `select='not(mod(n\\,${step}))',scale=${AW}:${ah}`, "-fps_mode", "passthrough",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
  const size = AW * ah * 3, out = [];
  for (let o = 0; o + size <= buf.length; o += size) out.push(buf.subarray(o, o + size));
  return { samples: out, aw: AW, ah };
}

/** One frame: wall colour (top corners), skin colour, face centre and size (fractions of the frame). */
function measureFrame(px, aw, ah) {
  const wall = [[], [], []];
  const patch = (x0, x1, y0, y1) => {
    for (let y = Math.floor(y0 * ah); y < y1 * ah; y++)
      for (let x = Math.floor(x0 * aw); x < x1 * aw; x++) {
        const i = (y * aw + x) * 3;
        wall[0].push(px[i]); wall[1].push(px[i + 1]); wall[2].push(px[i + 2]);
      }
  };
  patch(0.02, 0.14, 0.03, 0.22);
  patch(0.86, 0.98, 0.03, 0.22);

  // Skin = warm pixels (R > G > B) bright enough not to be wall, hair or the black top.
  const isSkin = (x, y) => {
    const i = (y * aw + x) * 3, r = px[i], g = px[i + 1], b = px[i + 2];
    return r > 70 && r > g && g > b && r - b > 15;
  };
  // Look only in the middle 40% of the width: the face is there, the hands mostly aren't.
  const x0 = Math.floor(aw * 0.3), x1 = Math.ceil(aw * 0.7);
  // Face top (hairline) = first row from the top with a few skin pixels.
  let top = -1;
  for (let y = 0; y < ah * 0.5 && top < 0; y++) {
    let k = 0;
    for (let x = x0; x < x1; x++) k += isSkin(x, y);
    if (k >= 3) top = y;
  }
  if (top < 0) return { face_px: 0 };
  // Measure in a band just under the hairline (forehead to cheekbones): face only, no neck,
  // and hands are rarely there. Width = skin pixels per row, its median over the band's rows.
  const b0 = top + Math.round(0.035 * ah), b1 = top + Math.round(0.085 * ah);
  const widths = [], skin = [0, 0, 0];
  let sumX = 0, n = 0;
  for (let y = b0; y < b1 && y < ah; y++) {
    let k = 0;
    for (let x = x0; x < x1; x++)
      if (isSkin(x, y)) {
        const i = (y * aw + x) * 3;
        k++; n++; sumX += x; skin[0] += px[i]; skin[1] += px[i + 1]; skin[2] += px[i + 2];
      }
    widths.push(k);
  }
  return {
    wall: wall.map(median),
    skin: n ? skin.map((v) => v / n) : [NaN, NaN, NaN],
    face_px: n,
    cx: n ? sumX / n / aw : NaN,     // face centre, left to right
    top: top / ah,                   // hairline, top to bottom
    size: median(widths) / aw,       // face width under the hairline: grows 1:1 with the zoom
  };
}

/** Measure one or more clips together: the median over all their sampled frames, so a hand passing
 *  in front of the face doesn't move the result. Pass every clip cut from ONE Recast job together:
 *  they share one look, so they must get one correction (else evening adds tiny jumps inside a job). */
export function measureClips(paths) {
  let info = null;
  const per = [];
  for (const path of [].concat(paths)) {
    const i = probe(path);
    if (info && (i.w !== info.w || i.h !== info.h)) throw new Error(`${path} is ${i.w}x${i.h}, its job's other clips are ${info.w}x${info.h}`);
    info ??= i;
    const { samples, aw, ah } = readSamples(path, i);
    for (const px of samples) {
      const m = measureFrame(px, aw, ah);
      if (m.face_px > 40) per.push(m);
    }
  }
  if (per.length < 3) throw new Error(`can't find the face in ${[].concat(paths).join(", ")}`);
  const pick = (k) => median(per.map((m) => m[k]));
  const ch = (k, c) => median(per.map((m) => m[k][c]));
  return {
    w: info.w, h: info.h, samples: per.length,
    wall: [0, 1, 2].map((c) => round(ch("wall", c), 1)),
    skin: [0, 1, 2].map((c) => round(ch("skin", c), 1)),
    cx: round(pick("cx")), top: round(pick("top")), size: round(pick("size")),
  };
}
export const measureClip = (path) => measureClips([path]);

/** The ffmpeg filter that moves clip measure `m` onto target `t`, plus the numbers it used. */
export function evenFilter(m, t, { color = true } = {}) {
  // 1. Colour: per channel, a straight line through two anchors (wall -> wall, skin -> skin).
  //    color: false leaves the colours alone (e.g. after normalize-backgrounds.py fixed the wall).
  const gain = [0, 1, 2].map((c) => (color ? clamp((t.skin[c] - t.wall[c]) / (m.skin[c] - m.wall[c]), LIMIT.gain) : 1));
  const off = [0, 1, 2].map((c) => (color ? t.wall[c] - gain[c] * m.wall[c] : 0));
  const lut = ["r", "g", "b"].map((k, c) => `${k}='clip(val*${gain[c].toFixed(4)}+${off[c].toFixed(2)},0,255)'`).join(":");
  const lutStep = color ? `lutrgb=${lut},` : "";

  // 2. Zoom so the face has the target's size, at the target's output size.
  //    The face (centre, hairline) is pinned to the target's place, so after the zoom the clip must
  //    still cover the whole frame on every side. If it doesn't, zoom in a little more: we never fill
  //    an empty edge (a mirrored edge copies hands and fingers, which would be a fake sign).
  const sFace = t.size / m.size;
  const sCover = Math.max(t.top / m.top, (1 - t.top) / (1 - m.top), t.cx / m.cx, (1 - t.cx) / (1 - m.cx));
  const s = clamp(Math.max(sFace, sCover), LIMIT.scale);
  const W = t.w, H = t.h;
  const sw = 2 * Math.ceil((W * s) / 2), sh = 2 * Math.ceil((H * s) / 2);

  // 3. Shift so the face lands on the target's place, then crop the target window.
  const offX = Math.min(sw - W, Math.max(0, Math.round(m.cx * sw - t.cx * W)));
  const offY = Math.min(sh - H, Math.max(0, Math.round(m.top * sh - t.top * H)));
  const filter = `${lutStep}scale=${sw}:${sh}:flags=lanczos,crop=${W}:${H}:${offX}:${offY}`;
  return {
    filter, gain: gain.map((g) => round(g, 3)), offset: off.map((o) => round(o, 1)),
    scale: round(sw / W, 4), shift_px: [offX, offY],
    extra_zoom_pct: round((Math.max(sFace, sCover) / sFace - 1) * 100, 1), // face bigger than target by this much, to cover the frame
  };
}

/** Pick the most typical clip as the target: closest to the median wall brightness and face size. */
export function pickTarget(measures) {
  const lum = (m) => m.wall[0] + m.wall[1] + m.wall[2];
  const mL = median(measures.map(([, m]) => lum(m))), mS = median(measures.map(([, m]) => m.size));
  let best = null;
  for (const [id, m] of measures) {
    const d = Math.abs(lum(m) - mL) / 30 + Math.abs(m.size / mS - 1) / 0.05;
    if (!best || d < best.d) best = { id, m, d };
  }
  return { from: best.id, ...best.m };
}
