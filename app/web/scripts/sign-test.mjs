// Fake-camera end-to-end test of #/sign: Chrome plays a .y4m clip as the webcam, the page tracks it with MediaPipe,
// it reads continuously (no clicks), and we check the recognizer's top-5. Saves docs/sign-tracking.png and docs/sign-result.png.
//   npm run dev:mock   (or npm run dev with the real recognizer behind app/server)   then
//   CLIPS="hello=C:/tmp/hello.y4m,water=C:/tmp/water.y4m" npm run sign-test
// Make clips: ffmpeg -i in.mp4 -vf "scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p" out.y4m
// Env: APP_URL (default http://localhost:5173), CHROME, OUT, SHOTS=0 to skip screenshots, DELEGATE=cpu|gpu,
// EMBED=1 opens #/sign?embed=1 with a fake window.ReactNativeWebView and checks the sentence/speak messages.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const APP = process.env.APP_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? path.resolve(import.meta.dirname, "../docs");
const CHROME = process.env.CHROME ?? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));
const clips = (process.env.CLIPS ?? "").split(",").filter(Boolean).map((s) => { const [label, file] = s.split("="); return { label, file: path.resolve(file) }; });
if (!clips.length) { console.error('set CLIPS="label=file.y4m,..."'); process.exit(2); }
const shots = process.env.SHOTS !== "0";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
for (const [ci, clip] of clips.entries()) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${clip.file}`, "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 520, height: 900, deviceScaleFactor: 2 });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  const shot = async (name) => { if (!shots) return; await (await page.$(".device")).screenshot({ path: path.join(OUT, name) }); console.log("  saved", name); };
  const r = { clip: clip.label, file: path.basename(clip.file) };
  const embed = process.env.EMBED === "1";
  if (embed) await page.evaluateOnNewDocument(() => { window.__rn = []; window.ReactNativeWebView = { postMessage: (s) => window.__rn.push(JSON.parse(s)) }; });
  try {
    if (ci === 0 && shots) {
      await page.goto(APP, { waitUntil: "networkidle0" });
      await sleep(1200);
      await shot("sign-home.png");
    }
    const t0 = Date.now();
    const q = [embed && "embed=1", process.env.DELEGATE && `delegate=${process.env.DELEGATE}`].filter(Boolean).join("&");
    await page.goto(`${APP}/#/sign${q ? `?${q}` : ""}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.querySelector("#signbtn")?.disabled, { timeout: 90_000 });
    r.loadS = +((Date.now() - t0) / 1000).toFixed(1);
    await sleep(2500); // a second of fps
    r.delegate = await page.evaluate(() => window.__sl?.delegate);
    r.fps = await page.evaluate(() => window.__sl?.fps);
    // Two tries per clip (the fake camera loops; a press can land mid-sign).
    for (let attempt = 1; attempt <= 2 && !r.top5; attempt++) {
      const before = await page.evaluate(() => window.__sl?.last ?? null);
      // The screen reads continuously (no tap): just wait for the next recognition.
      const got = await page.waitForFunction((b) => (window.__sl?.last && window.__sl.last !== b) || document.querySelector(".banner"), { timeout: 25_000 }, before).catch(() => null);
      const sl = await page.evaluate(() => ({ last: window.__sl?.last, frames: window.__sl?.frames, segMs: window.__sl?.segMs, reason: window.__sl?.reason, rtMs: window.__sl?.rtMs, banner: document.querySelector(".banner")?.textContent ?? null, hint: document.querySelector(".signhint")?.textContent ?? "" }));
      if (sl.banner) { r.error = sl.banner; break; }
      if (!got || !sl.last) { r.error = `no result (hint: ${sl.hint})`; continue; }
      r.error = undefined;
      r.top5 = sl.last.options.map((o) => `${o.label}:${o.confidence.toFixed(2)}`);
      r.frames = sl.frames; r.segMs = sl.segMs; r.reason = sl.reason; r.rtMs = sl.rtMs; r.inferMs = sl.last.timings?.inference_ms;
      r.rank = sl.last.options.findIndex((o) => o.label === clip.label) + 1;
      r.attempt = attempt;
    }
    r.fps2 = await page.evaluate(() => window.__sl?.fps);
    r.detectMs = await page.evaluate(() => window.__sl?.detectMs);
    if (embed && r.top5) {
      await page.click(".capbtn.speak");
      r.rnMessages = await page.evaluate(() => window.__rn.filter((m) => m.text));
    }
    if (ci === 0 && r.top5) {
      await sleep(700);
      r.sentence = await page.$eval(".sentence textarea", (t) => t.value);
      await shot("sign-result.png");
      // Tracking shot: wait for the next segment, and freeze the video mid-sign (hands up) so the frame and overlay match.
      const rec = await page.waitForFunction(() => document.querySelector(".island.rec"), { timeout: 15_000, polling: 30 }).catch(() => null);
      if (rec) {
        await page.evaluate(() => document.querySelector("video.cam").pause());
        await sleep(600);
        await shot("sign-tracking.png");
      }
    }
  } catch (e) {
    r.error = String(e.message ?? e);
  }
  if (errors.length) r.consoleErrors = errors.slice(0, 3);
  results.push(r);
  console.log(JSON.stringify(r));
  await browser.close();
}
const pass = results.filter((r) => r.rank > 0).length;
console.log(`\n${pass}/${results.length} clips had the expected sign in the top-5`);
