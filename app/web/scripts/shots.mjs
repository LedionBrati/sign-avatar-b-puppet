// Drive the app headless in typed mode and save screenshots to docs/.
//   npm run dev            (or dev:mock)   then   npm run shots
// Env: APP_URL (default http://localhost:5173), CHROME (path to Chrome), TEXT (sentence to sign), OUT (folder).
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const APP = process.env.APP_URL ?? "http://localhost:5173";
const TEXT = process.env.TEXT ?? "Thank you, see you later.";
const OUT = process.env.OUT ?? path.resolve(import.meta.dirname, "../docs");
const CHROME = process.env.CHROME ?? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 520, height: 900, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

const shot = async (name) => {
  const el = await page.$(".device");
  await el.screenshot({ path: path.join(OUT, name) });
  console.log("saved", path.join(OUT, name));
};

await page.goto(APP, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1500));
await shot("home.png");

await page.click("#type");
await page.type(".typebox input", TEXT);
await page.keyboard.press("Enter");
const t0 = Date.now();

// Record which clip is on screen each frame, to check the playlist plays through without stalls.
await page.evaluate(() => {
  window.__trace = [];
  const tick = () => {
    const v = document.querySelector(".sl-signer video.front");
    window.__trace.push({ t: performance.now(), src: v?.currentSrc.split("/").pop() ?? "", ct: v?.currentTime ?? 0, paused: v?.paused ?? true });
    if (!document.querySelector(".sumline")) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const midWord = process.env.MID ?? "SEE";
await page.waitForFunction((w) => document.querySelector(".nowline b")?.textContent === w, { timeout: 20000 }, midWord);
await new Promise((r) => setTimeout(r, 500));
await shot("live.png");

await page.waitForSelector(".sumline", { timeout: 30000 });
console.log(`done after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await new Promise((r) => setTimeout(r, 900));
await shot("done.png");

const trace = await page.evaluate(() => window.__trace);
let stall = 0;
for (let i = 1; i < trace.length; i++) {
  const a = trace[i - 1], b = trace[i];
  if (a.src && a.src === b.src && a.ct === b.ct && !b.paused) stall = Math.max(stall, b.t - a.t);
}
const starts = trace.filter((x, i, a) => x.src && x.src !== a[i - 1]?.src).map((x) => `${x.src}@${((x.t - trace[0].t) / 1000).toFixed(2)}s`);
console.log("clips on screen:", starts.join(" → "), `| end @${((trace.at(-1).t - trace[0].t) / 1000).toFixed(2)}s`);
console.log(`longest frozen stretch while playing: ${stall.toFixed(0)} ms`);
if (errors.length) console.log("console errors:\n  " + errors.join("\n  "));
await browser.close();
