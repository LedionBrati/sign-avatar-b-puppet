// Tab audio on a non-YouTube page: a local podcast page (test/podcast.html) plays a speech recording; the popup's
// "Tab audio" click starts tab capture; the transcripts must reach the signer. Saves docs/2030-tab-audio.png (+ -card).
//
//   npm run build && AUDIO=path/to/speech.wav node scripts/verify-tab-page.mjs
//   env: SIGNLAYER_API (default http://localhost:8787, needs transcribe: "ready"), OUT=dir (default docs), HEADFUL=1
import http from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ext = resolve(root, ".output/chrome-mv3");
const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const api = process.env.SIGNLAYER_API ?? "http://localhost:8787";
const audio = process.env.AUDIO;
const out = process.env.OUT ?? resolve(root, "docs");
const PORT = 8798;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!audio) throw new Error("AUDIO=path/to/speech.wav (any spoken English recording)");

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed = true; };

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/speech.wav") return res.writeHead(200, { "content-type": "audio/wav" }).end(await readFile(audio));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await readFile(resolve(root, "test/podcast.html")));
  } catch { res.writeHead(500).end(); }
});
await new Promise((r) => server.listen(PORT, r));
await mkdir(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: process.env.HEADFUL ? false : "new",
  defaultViewport: null,
  enableExtensions: true,
  ignoreDefaultArgs: ["--mute-audio"], // tab capture needs real audio
  args: ["--autoplay-policy=no-user-gesture-required", "--window-size=1280,800", "--no-first-run", "--no-default-browser-check", "--lang=en-US"],
});
try {
  const extId = await browser.installExtension(ext);
  const sw = await (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(extId), { timeout: 15000 })).worker();
  await sw.evaluate((apiUrl) => chrome.storage.local.set({ apiUrl, size: "m", corner: "br", captions: true, enabled: true, source: "captions", onboarded: true }), api);
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1280, height: 800 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.evaluate(() => document.getElementById("a").play());

  const extension = (await browser.extensions()).get(extId);
  const popupTarget = browser.waitForTarget((t) => t.url().includes(`${extId}/popup.html`), { timeout: 8000 }).catch(() => null);
  await extension.triggerAction(page);
  const popup = await (await popupTarget)?.asPage();
  check(!!popup, "toolbar action opened the popup");
  await popup.waitForSelector('#srcseg [data-v="tab"]');
  await popup.click('#srcseg [data-v="tab"]');
  let st;
  for (let i = 0; i < 20; i++) { st = await sw.evaluate(() => globalThis.__slTabAudio()); if (st.state !== "starting") break; await sleep(250); }
  check(st.state === "listening", `tab audio started: ${JSON.stringify(st)}`);
  await popup.close().catch(() => {});

  let f = null;
  for (let i = 0; i < 50 && !f; i++) { f = page.frames().find((fr) => fr.url().startsWith(`chrome-extension://${extId}/overlay.html`)); if (!f) await sleep(200); }
  check(!!f, "signer mounted on a non-YouTube page");
  const texts = [];
  let signed = false;
  const t0 = Date.now();
  while (f && Date.now() - t0 < 40000 && texts.length < 5) {
    const s = await f.evaluate(() => ({ state: document.getElementById("card").dataset.state, pill: document.getElementById("pill").textContent.replace(/\s+/g, " ").trim(), cc: (document.getElementById("cc").textContent || document.getElementById("focusText").textContent).replace(/\s+/g, " ").trim() }));
    if (s.state === "signing") signed = true;
    if (s.cc && !texts.includes(s.cc)) {
      texts.push(s.cc);
      log(`+${((Date.now() - t0) / 1000).toFixed(1)}s [${s.state}] ${s.pill} :: ${s.cc.slice(0, 80)}`);
      if (s.state === "signing" && !signed) signed = true;
    }
    if (signed && texts.length >= 2 && s.state === "signing") {
      await sleep(600);
      const b = await (await f.frameElement()).boundingBox();
      await page.screenshot({ path: resolve(out, "2030-tab-audio.png") });
      await page.screenshot({ path: resolve(out, "2030-tab-audio-card.png"), clip: { x: b.x - 28, y: b.y - 28, width: b.width + 56, height: Math.min(800 - b.y + 28, b.height + 56) } });
      log("saved 2030-tab-audio");
      break;
    }
    await sleep(250);
  }
  check(texts.length >= 1, `tab audio transcripts reached the signer: ${texts.length}`);
  check(signed, "tab audio speech was signed");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
