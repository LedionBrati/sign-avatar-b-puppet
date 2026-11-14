// Viewer page: source video | landmark skeleton | VRM puppet, synced.
// URL params:
//   motion=<path|url>   motion JSON (default: the synthetic fixture). Relative paths are from the repo root.
//   video=<path|url>    source clip, optional (aligned with motion.source.start_s)
//   view=sidebyside|skeleton|vrm   (default sidebyside)
//   size=540x720        panel size in pixels
//   closeup=1           hand close-up insets
//   solver=direct|kalidokit
//   mannequin=1         black top, skin-tone hands, dark wall
//   labels=0|1          overlays (default 1, except view=vrm in render mode)
//   model=<url>         VRM file (default /models/VRM1_Constraint_Twist_Sample.vrm)
//   render=1            offline mode for render.mjs: no controls, window.renderFrame(i) draws frame i
//   srcframes=<tpl>     render mode: source frames as images, e.g. /__file/C:/tmp/src_%05d.png (1-based)
import { duration, frameIndexAt, loadMotion, missingStats, type Motion } from "./motion";
import { drawSkeleton, COLORS } from "./skeleton";
import { VrmPuppet, type RetargetReport, type Solver } from "./vrm";

declare global {
  interface Window {
    puppetReady: Promise<{ frames: number; fps: number; width: number; height: number; warnings: string[] }>;
    renderFrame: (i: number) => Promise<RetargetReport | null>;
    /** render mode: the current frame as a base64 PNG of all panels */
    captureFrame: () => Promise<string>;
  }
}

const q = new URLSearchParams(location.search);
const RENDER = q.get("render") === "1";
const VIEW = (q.get("view") ?? "sidebyside") as "sidebyside" | "skeleton" | "vrm";
const [PW, PH] = (q.get("size") ?? "540x720").split("x").map(Number);
const LABELS = q.has("labels") ? q.get("labels") !== "0" : !(RENDER && VIEW === "vrm");
let closeup = q.get("closeup") === "1";
let solver = (q.get("solver") ?? "direct") as Solver;
const MANNEQUIN = q.get("mannequin") === "1";
const MODEL = q.get("model") ?? "/models/VRM1_Constraint_Twist_Sample.vrm";

/** local paths go through the dev server's /__file/ route (see vite.config.ts) */
export function resolveUrl(p: string): string {
  if (/^(https?:|blob:|data:)/.test(p)) return p;
  if (p.startsWith("/") && !/^\/[a-zA-Z]\//.test(p) && !p.startsWith("/__file/")) return p; // a dev-server path
  if (p.startsWith("/__file/")) return p;
  return "/__file/" + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const panelsEl = $("panels"), statusEl = $("status"), errorEl = $("error");
if (RENDER) document.body.classList.add("render");

function panel(tag?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "panel";
  d.style.width = `${PW}px`; d.style.height = `${PH}px`;
  panelsEl.appendChild(d);
  if (tag && LABELS) { const t = document.createElement("div"); t.className = "tag"; t.textContent = tag; d.appendChild(t); }
  return d;
}
function canvas(parent: HTMLElement, cls?: string) {
  const c = document.createElement("canvas");
  c.width = PW; c.height = PH;
  if (cls) c.className = cls;
  parent.appendChild(c);
  return c;
}

async function main() {
  const motionUrl = resolveUrl(q.get("motion") ?? "/fixtures/wave.json");
  const { motion, warnings } = await loadMotion(motionUrl);
  const startS = motion.source?.start_s ?? 0;
  const videoParam = q.get("video");
  const srcTpl = q.get("srcframes");

  // ---- panels
  let video: HTMLVideoElement | null = null;
  let srcCtx: CanvasRenderingContext2D | null = null;
  const wantSource = VIEW === "sidebyside" && (videoParam || srcTpl);
  if (wantSource) {
    const p = panel();
    if (RENDER && srcTpl) srcCtx = canvas(p).getContext("2d")!;
    else if (videoParam) {
      video = document.createElement("video");
      video.src = resolveUrl(videoParam); video.muted = true; video.playsInline = true; video.preload = "auto";
      video.style.objectFit = "contain"; video.style.background = "#000";
      p.appendChild(video);
    }
    if (LABELS) { const t = document.createElement("div"); t.className = "tag"; t.textContent = "Source (real signer)"; p.appendChild(t); }
  }
  let skelCtx: CanvasRenderingContext2D | null = null;
  if (VIEW !== "vrm") skelCtx = canvas(panel()).getContext("2d")!;
  let puppet: VrmPuppet | null = null;
  let vrmOverlay: CanvasRenderingContext2D | null = null;
  if (VIEW !== "skeleton") {
    const p = panel();
    const c = canvas(p);
    vrmOverlay = canvas(p, "overlay").getContext("2d")!;
    puppet = new VrmPuppet(c, PW, PH, { solver, closeup, mannequin: MANNEQUIN });
    await puppet.load(MODEL);
    (window as any).puppet = puppet; // for poking at from devtools
  }

  const stats = missingStats(motion);
  const srcImg = new Image();
  async function drawSource(i: number) {
    if (!srcCtx || !srcTpl) return;
    const url = srcTpl.replace(/%0(\d)d/, (_, w) => String(i + 1).padStart(Number(w), "0"));
    await new Promise<void>((res) => { srcImg.onload = () => res(); srcImg.onerror = () => res(); srcImg.src = resolveUrl(url); });
    srcCtx.fillStyle = "#000"; srcCtx.fillRect(0, 0, PW, PH);
    if (srcImg.naturalWidth) {
      const s = Math.min(PW / srcImg.naturalWidth, PH / srcImg.naturalHeight);
      const w = srcImg.naturalWidth * s, h = srcImg.naturalHeight * s;
      srcCtx.drawImage(srcImg, (PW - w) / 2, (PH - h) / 2, w, h);
    }
    if (LABELS) {
      srcCtx.font = `600 15px system-ui, "Segoe UI", sans-serif`;
      const t = "Source (real signer)"; const w = srcCtx.measureText(t).width;
      srcCtx.fillStyle = "rgba(0,0,0,.55)"; srcCtx.fillRect(4, 7, w + 8, 21);
      srcCtx.fillStyle = "#e8e8e8"; srcCtx.fillText(t, 8, 24);
    }
  }

  function drawFrame(i: number): RetargetReport | null {
    const f = motion.frames[i] ?? null;
    let report: RetargetReport | null = null;
    if (puppet) {
      puppet.opts.solver = solver; puppet.opts.closeup = closeup;
      report = puppet.applyFrame(f, motion);
      const o = vrmOverlay!;
      o.clearRect(0, 0, PW, PH);
      puppet.render((rects) => {
        if (!LABELS) return;
        for (const r of rects) {
          o.strokeStyle = r.side === "left" ? COLORS.left : COLORS.right; o.lineWidth = 2; o.strokeRect(r.x, r.y, r.size, r.size);
          tag(o, `${r.side === "left" ? "L" : "R"} hand (avatar)`, r.x + 6, r.y + 18, r.side === "left" ? COLORS.left : COLORS.right, 13);
        }
      });
      if (LABELS) {
        let y = 22;
        tag(o, `VRM puppet · ${solver}`, 8, y, "#e8e8e8", 15); y += 24;
        for (const t of report.tracking) { tag(o, `not tracked: ${t}`, 8, y, "#9aa0aa", 13); y += 21; }
        for (const t of report.retarget) { tag(o, `retarget: ${t}`, 8, y, "#ff6b6b", 13); y += 21; }
      }
    }
    if (skelCtx) drawSkeleton(skelCtx, f, motion, PW, PH, { closeup, labels: LABELS, title: LABELS ? "Landmarks (MediaPipe)" : undefined });
    return report;
  }

  window.renderFrame = async (i: number) => {
    await drawSource(i);
    return drawFrame(i);
  };
  // render mode: composite all panel canvases into one image (faster and more exact than a page screenshot)
  const layers = [...panelsEl.querySelectorAll("canvas")] as HTMLCanvasElement[];
  const comp = document.createElement("canvas");
  comp.width = PW * panelsEl.children.length; comp.height = PH;
  const compCtx = comp.getContext("2d")!;
  window.captureFrame = async () => {
    compCtx.fillStyle = "#000"; compCtx.fillRect(0, 0, comp.width, comp.height);
    for (const c of layers) {
      const k = [...panelsEl.children].indexOf(c.parentElement!);
      compCtx.drawImage(c, k * PW, 0, PW, PH);
    }
    const blob = await new Promise<Blob>((res) => comp.toBlob((b) => res(b!), "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    return btoa(s);
  };

  if (RENDER) return { motion, warnings };

  // ---- interactive controls
  $("controls").hidden = false;
  const seek = $<HTMLInputElement>("seek"), playBtn = $<HTMLButtonElement>("play");
  const speedSel = $<HTMLSelectElement>("speed"), closeChk = $<HTMLInputElement>("closeup"), solverSel = $<HTMLSelectElement>("solver");
  seek.max = String(motion.frames.length - 1);
  closeChk.checked = closeup; solverSel.value = solver;
  let cur = 0, playing = false, t = 0, last = 0;
  const show = (i: number) => {
    cur = Math.max(0, Math.min(motion.frames.length - 1, i));
    seek.value = String(cur);
    const r = drawFrame(cur);
    const lines = [`${motion.name} · ${motion.frames.length} frames @ ${motion.fps} fps · missing: pose ${stats.pose}, face ${stats.face}, L hand ${stats.leftHand}, R hand ${stats.rightHand}`];
    if (r) {
      const errs = Object.entries(r.err).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${Math.round(v!)}°`).join(" · ");
      lines.push(`retarget error: ${errs}`);
      if (r.retarget.length) lines.push(`<span class="bad">over threshold: ${r.retarget.join(", ")}</span>`);
    }
    if (warnings.length) lines.push(`file warnings: ${warnings.slice(0, 3).join("; ")}`);
    statusEl.innerHTML = lines.join("\n");
  };
  const syncVideo = () => { if (video) video.currentTime = startS + motion.frames[cur].t + 0.5 / motion.fps; };
  const setPlaying = (p: boolean) => {
    playing = p; playBtn.textContent = p ? "Pause" : "Play";
    if (video) { video.playbackRate = Number(speedSel.value); if (p) { syncVideo(); void video.play(); } else { video.pause(); syncVideo(); } }
    t = motion.frames[cur].t; last = performance.now();
  };
  playBtn.onclick = () => setPlaying(!playing);
  $("prev").onclick = () => { setPlaying(false); show(cur - 1); syncVideo(); };
  $("next").onclick = () => { setPlaying(false); show(cur + 1); syncVideo(); };
  seek.oninput = () => { setPlaying(false); show(Number(seek.value)); syncVideo(); };
  speedSel.onchange = () => { if (video) video.playbackRate = Number(speedSel.value); };
  closeChk.onchange = () => { closeup = closeChk.checked; show(cur); };
  solverSel.onchange = () => { solver = solverSel.value as Solver; show(cur); };
  addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") $("prev").click();
    else if (e.key === "ArrowRight") $("next").click();
    else if (e.key === " ") { e.preventDefault(); playBtn.click(); }
  });
  const tick = (now: number) => {
    if (playing) {
      if (video && !video.paused) t = video.currentTime - startS; // the video is the clock
      else t += ((now - last) / 1000) * Number(speedSel.value);
      last = now;
      if (t >= duration(motion)) { t = 0; if (video) syncVideo(); }
      const i = frameIndexAt(motion, t);
      if (i !== cur) show(i);
    }
    requestAnimationFrame(tick);
  };
  show(0); syncVideo();
  requestAnimationFrame(tick);
  return { motion, warnings };
}

function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number) {
  ctx.font = `600 ${size}px system-ui, "Segoe UI", sans-serif`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(x - 4, y - size + 1, w + 8, size + 6);
  ctx.fillStyle = color; ctx.fillText(text, x, y + 2);
}

window.puppetReady = main().then(({ motion, warnings }: { motion: Motion; warnings: string[] }) => ({
  frames: motion.frames.length, fps: motion.fps, width: motion.width, height: motion.height, warnings,
}));
window.puppetReady.catch((e) => { errorEl.textContent = String(e?.stack ?? e); console.error(e); });
