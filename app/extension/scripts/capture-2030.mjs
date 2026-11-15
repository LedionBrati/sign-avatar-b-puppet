// Design captures on a REAL YouTube video, for reviewing the look (docs/DESIGN.md). Not a pass/fail test: that is
// scripts/verify-youtube.mjs. Saves full-page shots plus tight crops of the signer card:
//   listening, signing, caption-only, confirm, hover toolbar, source menu, sizes S/M/L, fullscreen, popup, onboarding,
//   and a frame sequence while signing (seams between clips).
//
//   npm run build && node scripts/capture-2030.mjs
//   env: SIGNLAYER_API (default http://localhost:8787), VIDEO (default arj7oStGLkU), DARK=1 (dark YouTube + popup),
//        OUT=dir (default docs), PREFIX (default "2030-"), ONLY=listening,signing,blocked,hover,sizes,fullscreen,seq,popup
//        HEADFUL=1, CHROME=path
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ext = resolve(root, ".output/chrome-mv3");
const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const api = process.env.SIGNLAYER_API ?? "http://localhost:8787";
const video = process.env.VIDEO ?? "arj7oStGLkU";
const dark = !!process.env.DARK;
const out = process.env.OUT ?? resolve(root, "docs");
const prefix = (process.env.PREFIX ?? "2030-") + (dark ? "dark-" : "");
const only = (process.env.ONLY ?? "listening,signing,blocked,hover,sizes,fullscreen,seq,popup").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: process.env.HEADFUL ? false : "new",
  defaultViewport: null,
  enableExtensions: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--window-size=1280,800", "--no-first-run", "--no-default-browser-check", "--lang=en-US"],
});

try {
  await (await browser.target().createCDPSession()).send("Browser.setPermission", { permission: { name: "fullscreen", allowWithoutGesture: true }, setting: "granted" }).catch(() => {});
  const extId = await browser.installExtension(ext);
  const sw = await (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(extId), { timeout: 15000 })).worker();
  await sw.evaluate((apiUrl) => chrome.storage.local.set({ apiUrl, size: "m", corner: "br", captions: true, enabled: true, source: "captions", onboarded: true }), api);

  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1280, height: 800 });
  if (dark) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  page.on("console", (m) => /signlayer/i.test(m.text()) && log("[page]", m.text().slice(0, 160)));

  const frameOf = async (ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = page.frames().find((fr) => fr.url().startsWith(`chrome-extension://${extId}/overlay.html`));
      if (f) return f;
      await sleep(200);
    }
    return null;
  };
  const state = (f) => f.evaluate(() => ({ state: document.getElementById("card").dataset.state, pill: document.getElementById("pill").textContent.replace(/\s+/g, " ").trim() }));
  const box = async (f) => (await f.frameElement()).boundingBox();
  async function shot(name, f, { crop = true, full = true } = {}) {
    if (full) await page.screenshot({ path: resolve(out, `${prefix}${name}.png`) });
    if (crop && f) {
      const b = await box(f);
      const m = 28;
      const vp = page.viewport();
      const x = Math.max(0, b.x - m), y = Math.max(0, b.y - m);
      await page.screenshot({ path: resolve(out, `${prefix}${name}-card.png`), clip: { x, y, width: Math.min(vp.width - x, b.width + 2 * m), height: Math.min(vp.height - y, b.height + 2 * m) } });
    }
    log("saved", `${prefix}${name}`);
  }
  async function waitState(f, want, ms = 10000) {
    const t0 = Date.now();
    let s;
    while (Date.now() - t0 < ms) { s = await state(f); if (want.includes(s.state)) return s; await sleep(120); }
    return s;
  }
  async function playThroughAds() {
    for (let i = 0; i < 60; i++) {
      const s = await page.evaluate(() => {
        const v = document.querySelector("#movie_player video");
        if (!v) return null;
        v.muted = true;
        if (v.paused) v.play().catch(() => {});
        [...document.querySelectorAll("#movie_player button")].find((b) => /^skip/i.test(b.textContent.trim()) || /skip-ad|ad-skip/i.test(b.className))?.click();
        return { ad: !!document.querySelector(".ad-showing") };
      });
      if (s && !s.ad && i > 1) return;
      await sleep(1500);
    }
  }

  await page.goto(`https://www.youtube.com/watch?v=${video}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2500);
  // EU consent dialog: "Accept all".
  const accepted = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button, tp-yt-paper-button")].find((x) => /^accept all$/i.test(x.textContent.trim()) || /accept/i.test(x.getAttribute("aria-label") ?? ""));
    b?.click();
    return !!b;
  });
  if (accepted) await sleep(3000);
  const f = await frameOf();
  if (!f) throw new Error("no overlay");
  await page.waitForSelector("#movie_player video", { timeout: 30000 });
  await playThroughAds();
  await page.evaluate(() => { const v = document.querySelector("#movie_player video"); v.currentTime = 9; v.play(); });
  await page.mouse.move(300, 300);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://www.youtube.com/*" }))[0]?.id);
  const signText = (text) => sw.evaluate((id, t) => globalThis.__slSign(id, t), tabId, text);

  if (only.includes("listening")) {
    // Let the transcript drive it for a while: whatever state it is in after ~8 s.
    await sleep(8000);
    log("transcript state", await state(f));
    await shot("transcript", f);
  }
  await page.evaluate(() => document.querySelector("#movie_player video")?.pause());
  await sleep(600);

  if (only.includes("signing") || only.includes("seq")) {
    await signText("Hello, my name is. Thank you, see you later.");
    const s = await waitState(f, ["signing"]);
    log("signing", s);
    await sleep(500);
    if (only.includes("signing")) await shot("signing", f);
    if (only.includes("seq")) {
      // A frame sequence across clip boundaries: look for black frames or jumps.
      const b = await box(f);
      for (let i = 0; i < 24; i++) {
        await page.screenshot({ path: resolve(out, `${prefix}seq-${String(i).padStart(2, "0")}.png`), clip: { x: b.x, y: b.y, width: b.width, height: b.height } });
        await sleep(60);
      }
      log("saved seq");
    }
    await waitState(f, ["listening", "paused"], 15000);
  }

  if (only.includes("blocked")) {
    await signText("Quantum chromodynamics is fascinating.");
    log("blocked", await waitState(f, ["caption_only", "confirm"]));
    await sleep(900);
    await shot("caption-only", f);
    await signText("Hey there, thanks a lot");
    const s = await waitState(f, ["confirm", "caption_only", "signing"], 12000);
    log("paraphrase", s);
    await sleep(900);
    if (s.state === "confirm") await shot("confirm", f);
  }

  if (only.includes("hover")) {
    await signText("Hello, thank you.");
    await waitState(f, ["signing"]);
    const b = await box(f);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.4);
    await sleep(700);
    await shot("hover", f);
    await f.click("#srcBtn");
    await sleep(700);
    await shot("source-menu", f);
    await f.click("#srcBtn");
    await page.mouse.move(300, 300);
    await sleep(600);
  }

  if (only.includes("sizes")) {
    for (const z of ["s", "l", "m"]) {
      await sw.evaluate((size) => chrome.storage.local.set({ size }), z);
      await sleep(1200);
      await signText("Hello, thank you.");
      await waitState(f, ["signing"]);
      await sleep(400);
      if (z !== "m") await shot(`size-${z}`, f);
      else await shot("size-m", f);
      await waitState(f, ["listening", "paused"], 8000);
    }
  }

  if (only.includes("fullscreen")) {
    await page.evaluate(() => document.querySelector("#movie_player").requestFullscreen().catch(() => {}));
    await sleep(1500);
    await page.evaluate(() => document.querySelector("#movie_player video")?.play());
    await sleep(2500);
    await signText("Hello, thank you.");
    await waitState(f, ["signing"]);
    await sleep(400);
    await shot("fullscreen", f, { crop: false });
    await page.evaluate(() => document.exitFullscreen?.().catch(() => {}));
    await sleep(800);
  }

  if (only.includes("popup")) {
    for (const [name, onboarded] of [["popup", true], ["onboarding", false]]) {
      await sw.evaluate((o) => chrome.storage.local.set({ onboarded: o }), onboarded);
      const p = await browser.newPage();
      if (dark) await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
      await p.setViewport({ width: 360, height: 600 });
      await p.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
      await sleep(1400);
      const h = await p.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
      await p.setViewport({ width: 360, height: Math.min(600, h) });
      await sleep(300);
      await p.screenshot({ path: resolve(out, `${prefix}${name}.png`) });
      log("saved", `${prefix}${name}`, `${h}px`);
      await p.close();
    }
    await sw.evaluate(() => chrome.storage.local.set({ onboarded: true }));
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
