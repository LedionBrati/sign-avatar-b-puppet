// Offline, deterministic render of a motion file to mp4 (headless Chrome + ffmpeg).
// Each frame is drawn by window.renderFrame(i) in the viewer page (no realtime timing),
// screenshotted, and piped to ffmpeg (libx264, yuv420p). Output frames == motion frames (checked with ffprobe).
//
// Usage:
//   node puppet/render.mjs --motion PATH --view skeleton|vrm|sidebyside --out out/puppet/x.mp4
//        [--video SRC.mp4] [--size 540x720] [--fps 24] [--closeup] [--solver direct|kalidokit]
//        [--mannequin] [--labels 0|1] [--model URL] [--frames N] [--raw] [--gpu]
//
// The puppet is smoothed by default (src/track.ts: tracker glitches out, dropouts bridged, light zero-phase
// smoothing, hair/cloth physics); frame i of the video is still motion frame i, nothing lags.
// --raw renders every frame exactly as tracked, as before.
// --gpu   hardware WebGL (ANGLE on D3D11) instead of the default software SwiftShader. The WebGL
//         renderer string is printed and the run fails if Chrome still fell back to SwiftShader.
//         Pixels can differ by rounding between the two; frame count and timing do not.
//
// Paths are relative to the current directory. Writes <out>.json next to the mp4 with per-frame
// tracking failures and retargeting errors (degrees) of the pose that was rendered. Chrome: set
// CHROME=/path/to/chrome if it is not at the default location (same convention as pipeline/render-layers.mjs).

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) {
    if (fallback === undefined) { console.error(`Missing --${name}`); process.exit(1); }
    return fallback;
  }
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const flag = (name) => argv.includes(`--${name}`);

const motionPath = resolve(arg("motion"));
const view = arg("view", "sidebyside");
const out = resolve(arg("out"));
const videoPath = arg("video", null) ? resolve(arg("video")) : null;
const [W, H] = String(arg("size", "540x720")).split("x").map(Number);
const solver = arg("solver", "direct");
const closeup = flag("closeup");
const mannequin = flag("mannequin");
const labels = arg("labels", null);
const model = arg("model", null);
const raw = flag("raw");
const gpu = flag("gpu");
if (!["skeleton", "vrm", "sidebyside"].includes(view)) { console.error(`--view must be skeleton, vrm or sidebyside`); process.exit(1); }

const motion = JSON.parse(readFileSync(motionPath, "utf8"));
const N = Math.min(motion.frames.length, Number(arg("frames", motion.frames.length)));
const fps = Number(arg("fps", motion.fps));
if (fps !== motion.fps) console.warn(`note: --fps ${fps} differs from the motion's ${motion.fps} fps; frames are not resampled, the video just plays at ${fps} fps`);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) { console.error("Chrome not found; set CHROME=/path/to/chrome"); process.exit(1); }
  return hit;
}

const work = mkdtempSync(join(tmpdir(), "puppet-render-"));
const toUrlPath = (p) => "/__file/" + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");

// 1. source frames for the side-by-side view, cut exactly at the motion's time range
let srcTpl = null;
if (view === "sidebyside" && videoPath) {
  const start = motion.source?.start_s ?? 0;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(start), "-i", videoPath,
    "-vf", `fps=${motion.fps},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
    "-frames:v", String(N), join(work, "src_%05d.png")], { stdio: "inherit" });
  srcTpl = toUrlPath(join(work, "src_%05d.png")).replace("%2505d", "%05d");
}

// 2. dev server (serves the page, the model, and local files under /__file/)
const { createServer } = await import("vite");
const server = await createServer({ root: here, configFile: join(here, "vite.config.ts"), logLevel: "error", server: { port: 5190, strictPort: false, host: "127.0.0.1" } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");

const params = new URLSearchParams({ render: "1", view, size: `${W}x${H}`, motion: toUrlPath(motionPath), solver });
if (closeup) params.set("closeup", "1");
if (mannequin) params.set("mannequin", "1");
if (labels !== null) params.set("labels", String(labels));
if (model) params.set("model", model);
if (raw) params.set("smooth", "0");
if (srcTpl) params.set("srcframes", srcTpl);
const panels = view === "sidebyside" ? (srcTpl ? 3 : 2) : 1;
const pageW = W * panels;

// 3. headless Chrome
const puppeteer = (await import("puppeteer-core")).default;
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [...(gpu
    ? ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
  "--hide-scrollbars", "--force-device-scale-factor=1", "--no-first-run"],
  defaultViewport: { width: pageW, height: H, deviceScaleFactor: 1 },
});
let ffmpeg;
try {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warn") logs.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/index.html?${params}`, { waitUntil: "load", timeout: 120000 });
  let info;
  try {
    info = await page.evaluate(() => window.puppetReady);
  } catch (e) {
    const err = await page.evaluate(() => document.getElementById("error")?.textContent).catch(() => "");
    throw new Error(`page failed to start: ${e.message}\n${err}\n${logs.join("\n")}`);
  }
  const gl = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("webgl");
    const ext = c?.getExtension("WEBGL_debug_renderer_info");
    return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : c ? c.getParameter(c.RENDERER) : "no webgl";
  });
  const software = /swiftshader|software|llvmpipe/i.test(gl);
  console.log(`webgl: ${gl} (${software ? "software" : "hardware"})`);
  if (gpu && software) throw new Error("--gpu asked for hardware WebGL but Chrome fell back to software");
  if (info.warnings?.length) console.warn(`motion warnings: ${info.warnings.slice(0, 5).join("; ")}`);
  if (info.smoothing) console.log(`smoothing: ${info.smoothing.glitch} glitch, ${info.smoothing.bridged} bridged, ${info.smoothing.eased} eased bone-frames (--raw to turn off)`);
  else if (view !== "skeleton") console.log("smoothing: off (--raw)");

  mkdirSync(dirname(out), { recursive: true });
  ffmpeg = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", "-preset", "medium", "-r", String(fps), "-movflags", "+faststart", out],
  { stdio: ["pipe", "inherit", "inherit"] });
  const ffDone = new Promise((res, rej) => { ffmpeg.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))); });

  const reports = [];
  const t0 = Date.now();
  let tDraw = 0, tCap = 0;
  for (let i = 0; i < N; i++) {
    const a = Date.now();
    const r = await page.evaluate((k) => window.renderFrame(k), i);
    const b = Date.now();
    reports.push(r);
    const png = Buffer.from(await page.evaluate(() => window.captureFrame()), "base64");
    tDraw += b - a; tCap += Date.now() - b;
    if (!ffmpeg.stdin.write(png)) await new Promise((res) => ffmpeg.stdin.once("drain", res));
    if (i % 24 === 0 || i === N - 1) process.stdout.write(`\rframe ${i + 1}/${N}  (${((Date.now() - t0) / (i + 1)).toFixed(0)} ms/frame: draw ${(tDraw / (i + 1)).toFixed(0)}, capture ${(tCap / (i + 1)).toFixed(0)})   `);
  }
  process.stdout.write("\n");
  ffmpeg.stdin.end();
  await ffDone;
  if (logs.length) console.warn(`page messages:\n  ${[...new Set(logs)].slice(0, 10).join("\n  ")}`);

  // 4. verify the frame count
  const count = Number(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out]).toString().trim());
  const secs = (Date.now() - t0) / 1000;
  console.log(`wrote ${out}: ${count} frames, ${pageW}x${H} @ ${fps} fps (motion has ${N} frames), ${secs.toFixed(1)} s, ${(secs / N).toFixed(3)} s/frame, ${software ? "software" : "hardware"} webgl`);
  if (count !== N) { console.error(`FRAME COUNT MISMATCH: video ${count} vs motion ${N}`); process.exitCode = 2; }

  // 5. report: tracking failures (no landmarks) vs retargeting failures (landmarks there, avatar off)
  if (reports.some(Boolean)) {
    const keys = [...new Set(reports.filter(Boolean).flatMap((r) => Object.keys(r.err)))];
    const summary = {};
    for (const k of keys) {
      const vals = reports.map((r) => r?.err[k]).filter((v) => v !== null && v !== undefined);
      if (!vals.length) { summary[k] = { tracked_frames: 0 }; continue; }
      const sorted = [...vals].sort((a, b) => a - b);
      const worst = reports.reduce((best, r, i) => ((r?.err[k] ?? -1) > (best.v ?? -1) ? { i, v: r.err[k] } : best), { i: -1, v: -1 });
      summary[k] = {
        tracked_frames: vals.length,
        mean_deg: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1),
        median_deg: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
        max_deg: +worst.v.toFixed(1), worst_frame: worst.i,
        frames_over_threshold: reports.filter((r) => r?.retarget.some((s) => s.startsWith(k + " "))).length,
      };
    }
    const tracking = {};
    for (const r of reports) for (const t of r?.tracking ?? []) tracking[t] = (tracking[t] ?? 0) + 1;
    const rep = {
      motion: motionPath, view, solver, frames: N, fps,
      smoothing: info.smoothing ?? null,
      tracking_failures_frames: tracking,
      retarget_threshold_deg: 30,
      retarget_error: summary,
      per_frame: reports.map((r, i) => r && { i, tracking: r.tracking, retarget: r.retarget, err: Object.fromEntries(Object.entries(r.err).map(([k, v]) => [k, v === null ? null : +v.toFixed(1)])) }),
    };
    writeFileSync(out.replace(/\.mp4$/i, "") + ".json", JSON.stringify(rep, null, 1));
    console.log(`tracking failures (frames): ${JSON.stringify(tracking)}`);
    console.log("retargeting error (deg):");
    for (const [k, s] of Object.entries(summary)) if (s.tracked_frames) console.log(`  ${k.padEnd(14)} mean ${String(s.mean_deg).padStart(5)}  max ${String(s.max_deg).padStart(5)} @ frame ${s.worst_frame}  over 30deg: ${s.frames_over_threshold}`);
  }
} finally {
  // browser.close() can hang for minutes on Windows; give it a moment, then kill the process tree
  const timeout = (ms) => new Promise((res) => setTimeout(res, ms));
  await Promise.race([browser.close().catch(() => {}), timeout(5000)]);
  try { browser.process()?.kill("SIGKILL"); } catch {}
  await Promise.race([server.close().catch(() => {}), timeout(3000)]);
  rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
