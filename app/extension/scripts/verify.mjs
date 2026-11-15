// Quick local check (no YouTube): load the built extension in Chrome, open a test page, sign selected text,
// a blocked phrase and a supported one again, drag to a corner, check the popup. Screenshots: docs/.local-*.png.
// The real-YouTube check (captions, tab audio, fullscreen) is scripts/verify-youtube.mjs.
//   npm run build && node scripts/verify.mjs   (API at SIGNLAYER_API, default http://localhost:8787)
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const ext = resolve(root, ".output/chrome-mv3");
const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const api = process.env.SIGNLAYER_API ?? "http://localhost:8787";
const shots = process.env.QA_SHOTS_DIR ?? resolve(root, "docs");
const headless = process.env.HEADFUL ? false : "new";
const PORT = 8799;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  try {
    const html = await readFile(resolve(root, "test/page.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless,
  defaultViewport: null,
  // Branded Chrome ignores --load-extension since v137: install over CDP instead.
  enableExtensions: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,800",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed = true;
};

try {
  await browser.installExtension(ext);
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"), { timeout: 15000 });
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  console.log("extension id", extId);
  await sw.evaluate((apiUrl) => chrome.storage.local.set({ apiUrl, size: "m", corner: "br", captions: true, enabled: true, source: "selection", onboarded: true }), api);

  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await sleep(800);
  const tabId = await sw.evaluate(async (port) => (await chrome.tabs.query({ url: `http://localhost:${port}/*` }))[0]?.id, PORT);
  check(tabId != null, `test tab found (${tabId})`);

  const overlayFrame = async () => {
    for (let i = 0; i < 50; i++) {
      const f = page.frames().find((fr) => fr.url().startsWith(`chrome-extension://${extId}/overlay.html`));
      if (f) return f;
      await sleep(200);
    }
    return null;
  };
  const chip = (f) => f.evaluate(() => document.getElementById("pill")?.textContent ?? "");
  const waitChip = async (f, re, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const c = await chip(f);
      if (re.test(c)) return c;
      await sleep(100);
    }
    return chip(f);
  };

  // 1. Selected text, exactly what the context menu does.
  await sw.evaluate((id) => globalThis.__slSign(id, "Hello, thank you."), tabId);
  const f = await overlayFrame();
  check(!!f, "overlay iframe mounted");
  let c = await waitChip(f, /Signing/);
  check(/Signing/.test(c), `chip while signing: "${c}"`);
  await f.waitForFunction(() => [...document.querySelectorAll("video")].some((v) => v.classList.contains("on") && !v.paused && v.currentTime > 0), { timeout: 5000 });
  const state = await f.evaluate(() => ({
    words: [...document.querySelectorAll(".cc .w")].map((w) => `${w.textContent}:${w.className.replace("w ", "")}`),
    playing: [...document.querySelectorAll("video")].map((v) => ({ on: v.classList.contains("on"), paused: v.paused, t: +v.currentTime.toFixed(2), src: v.src.split("/").pop() })),
  }));
  console.log("captions", state.words.join(" "));
  console.log("videos", JSON.stringify(state.playing));
  check(state.playing.some((v) => v.on && !v.paused && v.t > 0), "a clip is playing");
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, ".local-m.png") });

  // A blocked phrase clears the playing queue and keeps its full caption visible.
  await sw.evaluate((id) => globalThis.__slSign(id, "Turn right at the bank."), tabId);
  c = await waitChip(f, /Captions only|Confirm/);
  check(/Captions only|Confirm/.test(c), `ambiguous phrase blocked: "${c}"`);
  const blocked = await f.evaluate(() => ({ caption: document.getElementById("cc")?.textContent,
    videos: [...document.querySelectorAll("video")].map((v) => ({ src: v.getAttribute("src"), paused: v.paused })) }));
  check(blocked.caption?.includes("Turn right at the bank.") && blocked.videos.every((v) => !v.src && v.paused),
    `blocked caption and empty queue: ${JSON.stringify(blocked)}`);
  await page.screenshot({ path: resolve(shots, ".local-blocked.png") });

  await sw.evaluate((id) => globalThis.__slSign(id, "Yes, thank you."), tabId);
  c = await waitChip(f, /Signing/);
  check(/Signing/.test(c), `playback resumes: "${c}"`);

  // 2. Size L from the settings (the hover control does the same).
  await sw.evaluate(() => chrome.storage.local.set({ size: "l" }));
  await sleep(1200);
  check((await (await f.frameElement()).boundingBox()).width > 330, "size L");
  await page.screenshot({ path: resolve(shots, ".local-l.png") });

  // 3. Drag to the top-left corner (overlay posts drag deltas; content script snaps + persists).
  const frameEl = await f.frameElement();
  const box = await frameEl.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(60, 60, { steps: 12 });
  await page.mouse.up();
  await sleep(900);
  const corner = await sw.evaluate(() => chrome.storage.local.get("corner").then((r) => r.corner));
  const box2 = await frameEl.boundingBox();
  check(corner === "tl", `dragged + snapped to corner "${corner}" at ${Math.round(box2.x)},${Math.round(box2.y)}`);
  await page.screenshot({ path: resolve(shots, ".drag-check.png") });

  // 4. Extension menu + mic side panel render (opened as tabs; headless has no toolbar).
  for (const [name, w, h] of [["popup", 350, 600], ["sidepanel", 360, 640]]) {
    const p = await browser.newPage();
    await p.setViewport({ width: w, height: h });
    await p.goto(`chrome-extension://${extId}/${name}.html`, { waitUntil: "load" });
    await sleep(1200);
    await p.screenshot({ path: resolve(shots, `.${name}.png`) });
    if (name === "popup") {
      const api = await p.evaluate(() => document.getElementById("statusText")?.textContent);
      check(/Ready/.test(api ?? ""), `popup API status: ${api}`);
    }
    await p.close();
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
