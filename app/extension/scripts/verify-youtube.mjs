// End-to-end check on a REAL YouTube video: load the built extension, open the video, and check that
//   1. captions source: the signer shows up by itself, follows the video's transcript (live captions in the sheet,
//      signs where the gate allows, "Captions only" + reason where it doesn't);
//   2. hover controls, size L, fullscreen (the signer moves into the fullscreen player);
//   3. tab audio: popup click -> tabCapture -> offscreen recorder -> POST /api/transcribe -> text in the signer;
//   4. caption-only / confirm states, popup, onboarding.
// Screenshots go to docs/2030-*.png (QA_SHOTS_DIR / SHOT_PREFIX to override).
//
//   npm run build && node scripts/verify-youtube.mjs
//   env: SIGNLAYER_API (default http://localhost:8787), VIDEO (default arj7oStGLkU, a TED talk with a transcript),
//        HEADFUL=1, SKIP_TAB=1, CHROME=path
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ext = resolve(root, ".output/chrome-mv3");
const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const api = process.env.SIGNLAYER_API ?? "http://localhost:8787";
const video = process.env.VIDEO ?? "arj7oStGLkU";
const shots = process.env.QA_SHOTS_DIR ?? resolve(root, "docs");
const prefix = process.env.SHOT_PREFIX ?? "2030-";
const only = (process.env.ONLY ?? "captions,controls,fullscreen,tab,states,popup").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed = true;
};

await mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: process.env.HEADFUL ? false : "new",
  defaultViewport: null,
  enableExtensions: true, // branded Chrome ignores --load-extension since v137: install over CDP instead
  // Puppeteer mutes headless Chrome by default; tab audio needs real audio to capture.
  ignoreDefaultArgs: ["--mute-audio"],
  args: ["--autoplay-policy=no-user-gesture-required", "--window-size=1280,800", "--no-first-run", "--no-default-browser-check", "--lang=en-US"],
});

try {
  // Chrome under automation answers "not granted" to fullscreen requests; grant it like a user would by clicking.
  await (await browser.target().createCDPSession()).send("Browser.setPermission", { permission: { name: "fullscreen", allowWithoutGesture: true }, setting: "granted" }).catch((e) => log("fullscreen permission:", e.message));
  const extId = await browser.installExtension(ext);
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(extId), { timeout: 15000 });
  const sw = await swTarget.worker();
  await sw.evaluate((apiUrl) => chrome.storage.local.set({ apiUrl, size: "m", corner: "br", captions: true, enabled: true, source: "captions", onboarded: true }), api);
  log("extension", extId);

  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1280, height: 800 });
  page.on("console", (m) => /signlayer/i.test(m.text()) && log("[page]", m.text().slice(0, 200)));
  const overlay = async (ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = page.frames().find((fr) => fr.url().startsWith(`chrome-extension://${extId}/overlay.html`));
      if (f) return f;
      await sleep(200);
    }
    return null;
  };
  const snap = (f) => f.evaluate(() => ({
    state: document.getElementById("card")?.dataset.state,
    pill: document.getElementById("pill")?.textContent?.replace(/\s+/g, " ").trim(),
    // Captions live in the sheet; a phrase the signer can't sign is shown large on the stage instead.
    cc: (document.getElementById("cc")?.textContent || document.getElementById("focusText")?.textContent || "").replace(/\s+/g, " ").trim(),
    note: document.getElementById("noteText")?.textContent ?? "",
    playing: [...document.querySelectorAll("video")].some((v) => v.classList.contains("on") && !v.paused && v.currentTime > 0),
  }));
  const shot = async (name) => {
    await page.screenshot({ path: resolve(shots, `${prefix}${name}.png`) });
    log("saved", `${prefix}${name}.png`);
  };
  const ytVideo = () => page.evaluate(() => {
    const v = document.querySelector("#movie_player video");
    return v ? { t: +v.currentTime.toFixed(1), paused: v.paused, ad: !!document.querySelector(".ad-showing") } : null;
  });
  async function playThroughAds(muted = true) {
    for (let i = 0; i < 70; i++) {
      const s = await page.evaluate((muted) => {
        const v = document.querySelector("#movie_player video");
        if (!v) return null;
        v.muted = muted;
        if (v.paused) v.play().catch(() => {});
        const skip = [...document.querySelectorAll("#movie_player button")].find((b) => /^skip/i.test(b.textContent.trim()) || /skip-ad|ad-skip/i.test(b.className));
        skip?.click();
        [...document.querySelectorAll("button")].find((b) => /^no thanks$/i.test(b.textContent.trim()))?.click();
        return { ad: !!document.querySelector(".ad-showing"), t: v.currentTime };
      }, muted);
      if (s && !s.ad && i > 1) return true;
      await sleep(1500);
    }
    return false;
  }

  // ── 1. Captions source on a real video ──
  await page.goto(`https://www.youtube.com/watch?v=${video}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2500);
  const consent = await page.$('button[aria-label*="Accept"], form[action*="consent"] button');
  if (consent) { log("consent: accept"); await consent.click(); await sleep(3000); }
  const f = await overlay();
  check(!!f, "signer mounted by itself on the YouTube watch page");
  if (!f) throw new Error("no overlay");
  await page.waitForSelector("#movie_player video", { timeout: 30000 });
  check(await playThroughAds(true), "video playing (ads skipped/waited)");
  // Start a few seconds before the first transcript line.
  await page.evaluate(() => { const v = document.querySelector("#movie_player video"); v.currentTime = 9; v.play(); });

  if (only.includes("captions")) {
    const seen = new Map();
    const t0 = Date.now();
    let first = null;
    while (Date.now() - t0 < 40000) {
      const s = await snap(f);
      const v = await ytVideo();
      if (s.cc && !seen.has(s.cc)) {
        seen.set(s.cc, s);
        if (!first) first = Date.now() - t0;
        log(`t=${v?.t}s [${s.state}] ${s.pill} :: ${s.cc.slice(0, 90)}${s.note ? `  (${s.note.slice(0, 80)})` : ""}`);
      }
      if (s.state === "caption_only" && !seen.get("__blocked")) { seen.set("__blocked", s); await shot("caption-only"); }
      if (s.state === "signing" && !seen.get("__signing")) { seen.set("__signing", s); await shot("signing"); }
      if (seen.size >= 6 && Date.now() - t0 > 25000) break;
      await sleep(300);
    }
    const lines = [...seen.keys()].filter((k) => !k.startsWith("__"));
    check(lines.length >= 3, `live captions followed the video: ${lines.length} lines (first after ${first} ms)`);
    const states = new Set([...seen.values()].map((s) => s.state));
    check([...states].every((st) => ["listening", "signing", "caption_only", "confirm", "paused"].includes(st)), `states seen: ${[...states].join(", ")}`);
    const pill = (await snap(f)).pill;
    check(/Listening|Transcript|Captions|Signing|Can't sign yet|Confirm/i.test(pill), `status pill: "${pill}"`);
    await shot("overlay-m");
  }

  if (only.includes("controls")) {
    const el = await f.frameElement();
    const box = await el.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 60);
    await sleep(500);
    const barOpacity = await f.evaluate(() => getComputedStyle(document.getElementById("bar")).opacity);
    check(Number(barOpacity) > 0.9, `hover shows the controls (opacity ${barOpacity})`);
    await shot("hover-controls");
    await f.click("#srcBtn");
    await sleep(400);
    check(await f.evaluate(() => !document.getElementById("srcMenu").hidden), "source menu opens");
    await shot("source-menu");
    await f.click("#srcBtn");
    // The size button cycles S -> M -> L.
    for (let i = 0; i < 3 && (await f.evaluate(() => document.body.dataset.size)) !== "l"; i++) { await f.click("#sizeBtn"); await sleep(250); }
    await page.mouse.move(400, 300);
    await sleep(1500);
    const w = (await el.boundingBox()).width;
    if (w < 330) log("size debug", await sw.evaluate(() => chrome.storage.local.get(["size"]).then(JSON.stringify)), await f.evaluate(() => document.body.dataset.size));
    check(w > 330, `size L applied (width ${Math.round(w)})`);
    await shot("overlay-l");
    // drag to the top-left corner and back
    const b2 = await el.boundingBox();
    await page.mouse.move(b2.x + b2.width / 2, b2.y + 120);
    await page.mouse.down();
    await page.mouse.move(120, 120, { steps: 14 });
    await page.mouse.up();
    await sleep(900);
    const corner = await sw.evaluate(() => chrome.storage.local.get("corner").then((r) => r.corner));
    check(corner === "tl", `drag snaps to a corner and remembers it ("${corner}")`);
    await sw.evaluate(() => chrome.storage.local.set({ corner: "br", size: "m" }));
    await sleep(800);
  }

  if (only.includes("fullscreen")) {
    // A real click on the player's fullscreen button (user activation), like a viewer would.
    await page.mouse.move(400, 300);
    await page.mouse.move(450, 320, { steps: 4 }); // wakes the player controls
    await sleep(400);
    const fsBtn = await page.evaluate(() => { const r = document.querySelector(".ytp-fullscreen-button")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; });
    if (fsBtn) await page.mouse.click(fsBtn.x, fsBtn.y);
    else await page.keyboard.press("f");
    await sleep(1800);
    if (!(await page.evaluate(() => !!document.fullscreenElement))) {
      log("fullscreen button did not switch (headless?); requesting fullscreen on the player directly");
      await page.evaluate(() => document.querySelector("#movie_player").requestFullscreen().catch((e) => console.log("fs error " + e.message)));
      await sleep(1500);
    }
    await page.mouse.move(200, 200);
    await sleep(2500); // let the player controls fade
    log("fullscreen debug", await page.evaluate(() => JSON.stringify({ enabled: document.fullscreenEnabled, btn: !!document.querySelector(".ytp-fullscreen-button") })));
    const fs = await page.evaluate(() => {
      const el = document.fullscreenElement;
      const host = document.querySelector("signlayer-overlay");
      return { fs: el ? el.id || el.tagName.toLowerCase() : null, inside: !!(el && host && el.contains(host)) };
    });
    const f2 = await overlay(3000);
    const alive = f2 ? await snap(f2) : null;
    check(fs.fs && fs.inside, `fullscreen: signer moved into the fullscreen player (${JSON.stringify(fs)})`);
    check(!!alive?.state, `signer still running in fullscreen [${alive?.state}] ${alive?.pill}`);
    await shot("fullscreen");
    await page.evaluate(() => document.exitFullscreen?.().catch(() => {}));
    await sleep(1200);
  }

  if (only.includes("states")) {
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: "https://www.youtube.com/*" }))[0]?.id);
    await page.evaluate(() => document.querySelector("#movie_player video")?.pause());
    await page.mouse.move(300, 300);
    await sleep(600);
    await sw.evaluate((id) => globalThis.__slSign(id, "Hello, thank you."), tabId);
    const t0 = Date.now();
    let s;
    while (Date.now() - t0 < 8000) { s = await snap(f); if (s.state === "signing" && s.playing) break; await sleep(150); }
    check(s?.state === "signing" && s.playing, `supported phrase signs: [${s?.state}] ${s?.pill}`);
    await shot("signing-text");
    await sw.evaluate((id) => globalThis.__slSign(id, "Turn right at the bank."), tabId);
    const t1 = Date.now();
    while (Date.now() - t1 < 10000) { s = await snap(f); if (s.state === "caption_only" || s.state === "confirm") break; await sleep(150); }
    const vids = await f.evaluate(() => [...document.querySelectorAll("video")].map((v) => ({ src: v.getAttribute("src"), paused: v.paused })));
    check((s.state === "caption_only" || s.state === "confirm") && s.cc.includes("Turn right at the bank.") && vids.every((v) => !v.src && v.paused),
      `blocked phrase: exact caption + reason, no stale video: [${s.state}] ${s.cc} (${s.note})`);
    await shot("caption-only-text");
    // needs_confirmation (a paraphrase): stopped until the viewer clicks "Show signs".
    await sw.evaluate((id) => globalThis.__slSign(id, "Hey there, thanks a lot"), tabId);
    const t2 = Date.now();
    while (Date.now() - t2 < 12000) { s = await snap(f); if (s.state === "confirm" || s.state === "caption_only" || s.state === "signing") break; await sleep(150); }
    if (s.state === "confirm") {
      check(!s.playing, `needs_confirmation waits for the viewer: ${s.note}`);
      await shot("confirm");
      await f.click('[data-act="confirm"]');
      const t3 = Date.now();
      while (Date.now() - t3 < 6000) { s = await snap(f); if (s.state === "signing" && s.playing) break; await sleep(150); }
      check(s.state === "signing", `"Show signs" plays the confirmed signs: ${s.pill}`);
      await page.mouse.move(300, 300);
    } else log(`(no needs_confirmation from this server for the paraphrase: [${s.state}])`);
  }

  if (only.includes("tab") && !process.env.SKIP_TAB) {
    // Tab audio: the popup click is the user gesture tabCapture needs (Extension.triggerAction opens the popup).
    await page.bringToFront();
    // Through the player API, so YouTube's own state agrees (unmuted, playing from 0:40).
    const resume = () => page.evaluate(() => { const p = document.querySelector("#movie_player"); p.unMute?.(); p.setVolume?.(100); if (p.getPlayerState?.() !== 1) p.playVideo?.(); });
    await page.evaluate(() => { const p = document.querySelector("#movie_player"); p.seekTo?.(40, true); });
    await resume();
    await playThroughAds(false);
    const extension = (await browser.extensions()).get(extId);
    const popupTarget = browser.waitForTarget((t) => t.url().includes(`${extId}/popup.html`), { timeout: 8000 }).catch(() => null);
    await extension.triggerAction(page);
    const pt = await popupTarget;
    const popup = pt ? await pt.asPage() : null;
    check(!!popup, "toolbar action opened the popup");
    if (popup) {
      await popup.waitForSelector('#srcseg [data-v="tab"]');
      const tStart = Date.now();
      await popup.click('#srcseg [data-v="tab"]');
      let st;
      for (let i = 0; i < 20; i++) { st = await sw.evaluate(() => globalThis.__slTabAudio()); if (st.state !== "starting") break; await sleep(250); }
      check(st.state === "listening", `tab audio started: ${JSON.stringify(st)}`);
      const off = await browser.waitForTarget((t) => t.url().includes(`${extId}/offscreen.html`), { timeout: 5000 }).catch(() => null);
      const op = off ? await off.asPage() : null;
      if (op && process.env.KEEP_AUDIO) await op.evaluate(() => { globalThis.__slTabAudio.keep = true; });
      await popup.close().catch(() => {});
      await page.bringToFront();
      await f.evaluate(() => (document.activeElement)?.blur?.());
      await page.mouse.move(300, 300);
      const texts = [];
      const tt = Date.now();
      while (Date.now() - tt < 30000 && texts.length < 6) {
        const s = await snap(f);
        if (s.cc && !texts.includes(s.cc) && s.cc !== "Captions appear here") {
          texts.push(s.cc);
          log(`+${((Date.now() - tStart) / 1000).toFixed(1)}s [${s.state}] ${s.pill} :: ${s.cc.slice(0, 90)}`);
          if (texts.length === 2) { await sleep(700); await shot("tab-audio"); }
        }
        if ((Date.now() - tt) % 3000 < 260) { const v = await ytVideo(); if (v?.paused) { log("video paused at", v.t, "-> resume"); await resume(); } }
        await sleep(250);
      }
      check(texts.length >= 1, `tab audio transcripts reached the signer: ${texts.length}`);
      if (op) {
        const d = await op.evaluate(() => globalThis.__slTabAudio);
        for (const c of d.chunks) log(`chunk ${c.ms} ms, ${c.bytes} B -> ${c.latency_ms} ms: ${c.text.slice(0, 70)}`);
        const lat = d.chunks.map((c) => c.latency_ms).sort((a, b) => a - b);
        if (lat.length) log(`transcribe round trip: median ${lat[lat.length >> 1]} ms, min ${lat[0]}, max ${lat.at(-1)} (n=${lat.length})`);
        if (process.env.KEEP_AUDIO) {
          const { writeFile } = await import("node:fs/promises");
          await mkdir(process.env.KEEP_AUDIO, { recursive: true });
          for (const [i, b] of d.blobs.entries()) await writeFile(resolve(process.env.KEEP_AUDIO, `chunk-${i}.webm`), Buffer.from(b.b64, "base64"));
          log(`kept ${d.blobs.length} chunks in ${process.env.KEEP_AUDIO}`);
        }
      }
      await sw.evaluate(async () => { await chrome.storage.local.set({ source: "captions" }); });
    }
  }

  if (only.includes("popup")) {
    for (const [name, onboarded, h] of [["popup", true, 560], ["onboarding", false, 640]]) {
      await sw.evaluate((o) => chrome.storage.local.set({ onboarded: o }), onboarded);
      const p = await browser.newPage();
      await p.setViewport({ width: 356, height: h });
      await p.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
      await sleep(1500);
      // A real popup is as tall as its content (Chrome caps it at 600 px).
      const ch = await p.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
      check(ch <= 600, `${name} fits a Chrome popup (${ch} px tall)`);
      await p.setViewport({ width: 356, height: ch });
      await sleep(300);
      await p.screenshot({ path: resolve(shots, `${prefix}${name}.png`) });
      log("saved", `${prefix}${name}.png`);
      if (name === "popup") {
        const status = await p.evaluate(() => document.getElementById("statusText")?.textContent);
        check(/Ready/.test(status), `popup server status: ${status}`);
      }
      await p.close();
    }
    await sw.evaluate(() => chrome.storage.local.set({ onboarded: true }));
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
