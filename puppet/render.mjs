// Offline, deterministic render of a motion file to mp4 (headless Chrome + ffmpeg).
// Each frame is drawn by window.renderFrame(i) in the viewer page (no realtime timing),
// screenshotted, and piped to ffmpeg (libx264, yuv420p). Output frames == motion frames (checked with ffprobe).
//
// Usage:
//   node puppet/render.mjs --motion PATH --view skeleton|vrm|sidebyside --out out/puppet/x.mp4
//        [--video SRC.mp4] [--size 540x720] [--fps 24] [--closeup] [--solver direct|kalidokit]
//        [--mannequin] [--labels 0|1] [--model URL] [--frames N] [--raw] [--gpu]
//        [--avatar signer] [--solver anatomic] [--passes rgb,depth,normal,seg] [--aa 0] [--capture jpeg|raw|post|png] [--workers N]
//
// --avatar signer   the realistic reference avatar (puppet/models/signer.glb, puppet/avatar/README.md); its
//                   default solver is anatomic (src/hand.ts: joint limits, fingertip IK, no finger overlap).
// --passes          extra passes from the same camera, each written to its own mp4 next to --out:
//                   x.mp4 (rgb), x.depth.mp4, x.normal.mp4, x.seg.mp4 (all frame-aligned, view vrm only).
// --capture jpeg    (default for --view vrm) the page encodes each frame with the browser's own JPEG encoder
//                   (quality --jpeg-quality, default 0.95) and hands back 24 frames per page call; ffmpeg reads
//                   them as mjpeg. About 15x fewer bytes than raw, no PNG encode/decode.
//           raw     readPixels RGBA, base64 over the DevTools protocol, rawvideo into ffmpeg: lossless, but the
//                   ~1.5 MB/frame transfer makes it slower than jpeg here. Use it when depth must be exact.
//           post    raw pixels as a binary HTTP POST to the render server (slower still on Windows).
//           png     the old path (page composites all panels, toBlob PNG, base64). Default for other views.
// --workers N       N Chrome processes render interleaved 1 s chunks (jpeg/raw capture). On this 10-core laptop it
//                   did not help: SwiftShader already uses every core. Kept for many-core machines.
// --aa 0            no multisampling: faster on software WebGL, slightly jaggier edges.
// --bg-image PATH   an image behind the avatar instead of the flat wall colour (e.g. assets/avatar/wall-plate.jpg,
//                   3:4 like the frame). Data passes (depth/normal/seg) keep their flat backgrounds.
// --lite            cheap shading (Lambert, hemisphere light, no environment map) for software WebGL.
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
const avatar = arg("avatar", null);
const model = arg("model", null) ?? (avatar === "signer" ? "/models/signer.glb" : null);
const solver = arg("solver", model && /\.(glb|gltf)$/i.test(model) ? "anatomic" : "direct");
const closeup = flag("closeup");
const mannequin = flag("mannequin");
const labels = arg("labels", null);
const raw = flag("raw");
const gpu = flag("gpu");
const passes = String(arg("passes", "rgb")).split(",").filter(Boolean);
const aa = String(arg("aa", "1")) !== "0";
const lite = flag("lite");
const capture = String(arg("capture", view === "vrm" ? "jpeg" : "png")); // jpeg | raw | post | png
const jpegQ = Number(arg("jpeg-quality", 0.95));
if (!["skeleton", "vrm", "sidebyside"].includes(view)) { console.error(`--view must be skeleton, vrm or sidebyside`); process.exit(1); }
if (passes.some((p) => !["rgb", "depth", "normal", "seg"].includes(p))) { console.error("--passes: rgb, depth, normal, seg"); process.exit(1); }
if ((passes.length > 1 || passes[0] !== "rgb") && view !== "vrm") { console.error("--passes needs --view vrm"); process.exit(1); }
if (capture !== "png" && view !== "vrm") { console.error("--capture jpeg|raw|post needs --view vrm"); process.exit(1); }
if (!["png", "jpeg", "raw", "post"].includes(capture)) { console.error("--capture: jpeg, raw, post or png"); process.exit(1); }
const passOut = (p, k) => (k === 0 ? out : out.replace(/\.mp4$/i, "") + `.${p}.mp4`);

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
// raw capture: the page POSTs each frame's RGBA pixels to /__sink; they go straight to ffmpeg's stdin, in order
let sinkWrite = null;
const sink = {
  name: "frame-sink",
  configureServer(s) {
    s.middlewares.use("/__sink", (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        try { await sinkWrite(Buffer.concat(chunks)); res.statusCode = 204; res.end(); }
        catch (e) { res.statusCode = 500; res.end(String(e)); }
      });
    });
  },
};
const server = await createServer({ root: here, configFile: join(here, "vite.config.ts"), logLevel: "error", plugins: [sink], server: { port: 5190, strictPort: false, host: "127.0.0.1" } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");

const params = new URLSearchParams({ render: "1", view, size: `${W}x${H}`, motion: toUrlPath(motionPath), solver });
if (closeup) params.set("closeup", "1");
if (mannequin) params.set("mannequin", "1");
if (labels !== null) params.set("labels", String(labels));
if (model) params.set("model", model);
if (raw) params.set("smooth", "0");
if (srcTpl) params.set("srcframes", srcTpl);
if (passes.join(",") !== "rgb") params.set("passes", passes.join(","));
if (!aa) params.set("aa", "0");
if (lite) params.set("lite", "1");
const bgImage = arg("bg-image", null);
if (bgImage) params.set("bgimage", toUrlPath(resolve(bgImage)));
const panels = view === "sidebyside" ? (srcTpl ? 3 : 2) : passes.length;
const pageW = W * panels;

// 3. headless Chrome
const puppeteer = (await import("puppeteer-core")).default;
// hardware WebGL: ANGLE on D3D11 (Windows), Metal (macOS), Vulkan (Linux, e.g. an NVIDIA cloud GPU with the
// Vulkan driver). The run stops if Chrome still falls back to software, so a GPU you pay for is really used.
const gpuArgs = process.platform === "win32" ? ["--use-angle=d3d11"]
  : process.platform === "darwin" ? ["--use-angle=metal"]
  : ["--use-angle=vulkan", "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan"];
// containers run as root, where Chrome needs --no-sandbox; /dev/shm is small in Docker
const containerArgs = process.platform === "linux" ? ["--disable-dev-shm-usage", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])] : [];
const launch = () => puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [...(gpu
    ? ["--enable-gpu", ...gpuArgs, "--ignore-gpu-blocklist", "--enable-gpu-rasterization"]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]),
  ...containerArgs, "--hide-scrollbars", "--force-device-scale-factor=1", "--no-first-run"],
  defaultViewport: { width: pageW, height: H, deviceScaleFactor: 1 },
});
// --workers N (fast capture only): N Chrome processes render interleaved 24-frame chunks. Software WebGL runs
// one context on a few threads; separate processes use the other cores. Frames are still written in order.
// Each worker solves the motion itself (same deterministic bake). With hair/cloth physics (the VRM) the springs
// restart at each chunk a worker skips to, so keep 1 worker for the VRM; the signer has no springs.
const workers = Math.max(1, Number(arg("workers", 1)));
const browsers = [await launch()];
const browser = browsers[0];
const logs = [];
async function openPage(b) {
  const page = await b.newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warn") logs.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/index.html?${params}`, { waitUntil: "load", timeout: 120000 });
  try {
    return { page, info: await page.evaluate(() => window.puppetReady) };
  } catch (e) {
    const err = await page.evaluate(() => document.getElementById("error")?.textContent).catch(() => "");
    throw new Error(`page failed to start: ${e.message}\n${err}\n${logs.join("\n")}`);
  }
}
let ffmpeg;
try {
  const extra = capture !== "png" && workers > 1
    ? Promise.all(Array.from({ length: workers - 1 }, async () => { const b = await launch(); browsers.push(b); return openPage(b); }))
    : Promise.resolve([]);
  const { page, info } = await openPage(browser);
  const pages = [page, ...(await extra).map((x) => x.page)];
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
  const x264 = (crf, preset) => ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(crf), "-preset", preset, "-r", String(fps), "-movflags", "+faststart"];
  const ffArgs = ["-v", "error", "-y"];
  const fast = capture !== "png";
  if (fast) {
    // one wide frame (passes side by side) -> split -> one mp4 per pass. raw/post: RGBA rows bottom-up from readPixels
    if (capture === "jpeg") ffArgs.push("-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-");
    else ffArgs.push("-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${pageW}x${H}`, "-framerate", String(fps), "-i", "-");
    const k = passes.length;
    const head = capture === "jpeg" ? "[0:v]null" : "[0:v]vflip";
    const graph = [`${head}${k > 1 ? `,split=${k}${passes.map((_, j) => `[s${j}]`).join("")}` : "[s0]"}`,
      ...passes.map((_, j) => `[s${j}]crop=${W}:${H}:${j * W}:0[o${j}]`)].join(";");
    ffArgs.push("-filter_complex", graph);
    // rgb keeps the old quality; data passes are flat images that encode fast
    passes.forEach((p, j) => ffArgs.push("-map", `[o${j}]`, ...(p === "rgb" ? x264(17, "medium") : x264(12, "veryfast")), passOut(p, j)));
  } else {
    ffArgs.push("-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", ...x264(17, "medium"), out);
  }
  ffmpeg = spawn("ffmpeg", ffArgs, { stdio: ["pipe", "inherit", "inherit"] });
  const ffDone = new Promise((res, rej) => { ffmpeg.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))); });
  const write = async (buf) => { if (!ffmpeg.stdin.write(buf)) await new Promise((res) => ffmpeg.stdin.once("drain", res)); };

  const reports = [];
  const t0 = Date.now();
  let tDraw = 0, tCap = 0;
  if (fast) {
    let got = 0;
    sinkWrite = async (buf) => {
      if (capture !== "jpeg" && buf.length !== pageW * H * 4) throw new Error(`frame ${got}: ${buf.length} bytes, expected ${pageW * H * 4}`);
      await write(buf);
      got++;
      if (got % 24 === 0 || got === N) process.stdout.write(`\rframe ${got}/${N}  (${((Date.now() - t0) / got).toFixed(0)} ms/frame)   `);
    };
    const CHUNK = 24; // one page call per second of video
    const ms = { draw: 0, read: 0, post: 0 };
    let tTransfer = 0;
    if (capture === "post" && pages.length > 1) throw new Error("--capture post works with 1 worker only");
    // chunks are handed out in order; finished ones wait in `ready` until everything before them is written
    const chunks = [];
    for (let a = 0; a < N; a += CHUNK) chunks.push([a, Math.min(N, a + CHUNK)]);
    const ready = new Map();
    let nextChunk = 0, nextWrite = 0, writing = Promise.resolve();
    const flush = () => {
      writing = writing.then(async () => {
        while (ready.has(nextWrite)) {
          const r = ready.get(nextWrite); ready.delete(nextWrite); nextWrite++;
          reports.push(...r.reports);
          for (const f of r.frames) await sinkWrite(Buffer.from(f, "base64"));
        }
      });
      return writing;
    };
    await Promise.all(pages.map(async (pg) => {
      while (nextChunk < chunks.length) {
        const k = nextChunk++;
        const [from, to] = chunks[k];
        const c0 = Date.now();
        const r = await pg.evaluate((a, b, s, q) => window.renderRange(a, b, s, q), from, to,
          capture === "post" ? "/__sink" : null, capture === "jpeg" ? jpegQ : 0);
        tTransfer += Date.now() - c0 - (r.ms.draw + r.ms.read + r.ms.post);
        for (const key of Object.keys(ms)) ms[key] += r.ms[key];
        if (capture === "post") reports.push(...r.reports);
        else { ready.set(k, r); flush(); }
      }
    }));
    await flush();
    process.stdout.write("\n");
    console.log(`per frame (summed over ${pages.length} worker(s)): draw ${(ms.draw / N).toFixed(1)} ms, ${capture === "jpeg" ? "jpeg encode" : "readPixels"} ${(ms.read / N).toFixed(1)}, ${capture === "post" ? "POST" : "base64"} ${(ms.post / N).toFixed(1)}, page -> node ${(tTransfer / N).toFixed(1)}`);
  } else {
    for (let i = 0; i < N; i++) {
      const a = Date.now();
      const r = await page.evaluate((k) => window.renderFrame(k), i);
      const b = Date.now();
      reports.push(r);
      const png = Buffer.from(await page.evaluate(() => window.captureFrame()), "base64");
      tDraw += b - a; tCap += Date.now() - b;
      await write(png);
      if (i % 24 === 0 || i === N - 1) process.stdout.write(`\rframe ${i + 1}/${N}  (${((Date.now() - t0) / (i + 1)).toFixed(0)} ms/frame: draw ${(tDraw / (i + 1)).toFixed(0)}, capture ${(tCap / (i + 1)).toFixed(0)})   `);
    }
    process.stdout.write("\n");
  }
  const tRender = (Date.now() - t0) / 1000;
  ffmpeg.stdin.end();
  await ffDone;
  if (logs.length) console.warn(`page messages:\n  ${[...new Set(logs)].slice(0, 10).join("\n  ")}`);

  // 4. verify the frame count of every output
  const secs = (Date.now() - t0) / 1000;
  const outs = capture !== "png" ? passes.map(passOut) : [out];
  for (const o of outs) {
    const count = parseInt(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", o]).toString().trim());
    console.log(`wrote ${o}: ${count} frames, ${capture !== "png" ? W : pageW}x${H} @ ${fps} fps (motion has ${N} frames)`);
    if (count !== N) { console.error(`FRAME COUNT MISMATCH: video ${count} vs motion ${N}`); process.exitCode = 2; }
  }
  console.log(`time: ${secs.toFixed(1)} s total, ${(secs / N).toFixed(3)} s/frame (${(N / secs).toFixed(1)} fps; frames drawn+captured in ${tRender.toFixed(1)} s), ${passes.length} pass(es), ${software ? "software" : "hardware"} webgl, capture ${capture}, aa ${aa ? "on" : "off"}`);

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
    // hands as shown: joint-limit violations and overlapping fingers (src/hand.ts), only where the hand is tracked
    const limits = { violations: 0, overlaps: 0, frames_with_violation: 0, hand_frames: 0 };
    for (const r of reports) {
      if (!r?.limits) continue;
      for (const S of ["L", "R"]) {
        if (r.err[`${S} fingers`] === null || r.err[`${S} fingers`] === undefined) continue;
        limits.hand_frames++;
        limits.violations += r.limits[S];
        limits.overlaps += r.limits[`overlaps${S}`];
        if (r.limits[S]) limits.frames_with_violation++;
      }
    }
    const rep = {
      motion: motionPath, view, solver, model: model ?? "VRM1_Constraint_Twist_Sample.vrm", frames: N, fps, passes,
      seconds: +secs.toFixed(2), seconds_per_frame: +(secs / N).toFixed(4), webgl: software ? "software" : "hardware", capture, aa,
      smoothing: info.smoothing ?? null,
      tracking_failures_frames: tracking,
      hand_limits: limits,
      retarget_threshold_deg: 30,
      retarget_error: summary,
      per_frame: reports.map((r, i) => r && { i, tracking: r.tracking, retarget: r.retarget, limits: r.limits, err: Object.fromEntries(Object.entries(r.err).map(([k, v]) => [k, v === null ? null : +v.toFixed(1)])) }),
    };
    writeFileSync(out.replace(/\.mp4$/i, "") + ".json", JSON.stringify(rep, null, 1));
    console.log(`tracking failures (frames): ${JSON.stringify(tracking)}`);
    console.log(`hand joint-limit violations: ${limits.violations} in ${limits.frames_with_violation} of ${limits.hand_frames} tracked hand-frames; overlapping fingers: ${limits.overlaps}`);
    console.log("retargeting error (deg):");
    for (const [k, s] of Object.entries(summary)) if (s.tracked_frames) console.log(`  ${k.padEnd(14)} mean ${String(s.mean_deg).padStart(5)}  max ${String(s.max_deg).padStart(5)} @ frame ${s.worst_frame}  over 30deg: ${s.frames_over_threshold}`);
  }
} finally {
  // browser.close() can hang for minutes on Windows; give it a moment, then kill the process tree
  const timeout = (ms) => new Promise((res) => setTimeout(res, ms));
  await Promise.race([Promise.all(browsers.map((b) => b.close().catch(() => {}))), timeout(5000)]);
  for (const b of browsers) { try { b.process()?.kill("SIGKILL"); } catch {} }
  await Promise.race([server.close().catch(() => {}), timeout(3000)]);
  rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
