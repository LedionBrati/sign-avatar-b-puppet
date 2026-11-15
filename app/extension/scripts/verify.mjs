// End-to-end check of the side panel with Tab audio, in real Chrome:
//   a local page plays a speech recording -> the toolbar action is clicked (opens the side panel, grants activeTab)
//   -> Tab audio + Start -> chunks reach /api/transcribe -> text -> /api/sign -> the signer plays.
// Screenshots: docs/panel-{idle,listening,signing,caption-only}.png.
//
//   npm run build && AUDIO=path/to/speech.ogg node scripts/verify.mjs
//   env: SIGNLAYER_API (default http://localhost:8787; needs transcribe "ready"), SEEK=seconds into the audio,
//        OUT=dir (default docs), HEADFUL=1
import http from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ext = resolve(root, ".output/chrome-mv3");
const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const api = process.env.SIGNLAYER_API ?? "http://localhost:8787";
const audio = process.env.AUDIO;
const seek = Number(process.env.SEEK ?? 0);
const out = process.env.OUT ?? resolve(root, "docs");
const PORT = 8799;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!audio) throw new Error("AUDIO=path/to/speech (any spoken English recording)");

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed = true; };

const mime = { ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "audio/webm" }[extname(audio)] ?? "application/octet-stream";
const page_html = `<!doctype html><title>Podcast</title><body style="font:16px system-ui;padding:40px">
<h1>Rice University, 1962</h1><audio id="a" src="/speech" controls loop></audio></body>`;
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/speech") return res.writeHead(200, { "content-type": mime }).end(await readFile(audio));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page_html);
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
  args: ["--autoplay-policy=no-user-gesture-required", "--window-size=1280,820", "--no-first-run", "--no-default-browser-check", "--lang=en-US"],
});
try {
  const extId = await browser.installExtension(ext);
  const sw = await (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(extId), { timeout: 15000 })).worker();
  await sw.evaluate((apiUrl) => chrome.storage.local.set({ apiUrl, source: "mic" }), api);
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.evaluate((t) => { const a = document.getElementById("a"); a.currentTime = t; return a.play(); }, seek);
  const tabId = await sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0]?.id));

  // The toolbar click: opens the side panel and grants activeTab on this tab.
  const extension = (await browser.extensions()).get(extId);
  const panelTarget = browser.waitForTarget((t) => t.url().includes(`${extId}/sidepanel.html`), { timeout: 5000 }).catch(() => null);
  await extension.triggerAction(page);
  const real = await panelTarget;
  check(!!real, "toolbar click opened the side panel");
  // Drive (and screenshot) the panel page in a tab of panel size; ?tab= names the tab the click invoked.
  // (The real side panel can't be resized or screenshotted reliably; the page is the same.)
  if (real) await (await real.asPage().catch(() => null))?.close().catch(() => {});
  const panel = await browser.newPage();
  await panel.setViewport({ width: 380, height: 800, deviceScaleFactor: 2 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`, { waitUntil: "load" });
  const state = () => panel.evaluate(() => ({
    view: document.body.dataset.state, pill: document.getElementById("pill").textContent.replace(/\s+/g, " ").trim(),
    cc: document.getElementById("cc").textContent.replace(/\s+/g, " ").trim(), focus: document.getElementById("focusText").textContent.trim(),
    note: document.getElementById("note").textContent.trim(),
    chunks: globalThis.__slTab?.chunks ?? [], phrases: globalThis.__sl?.phrases ?? [],
  }));
  await sleep(2500);
  const shot = (name) => panel.screenshot({ path: resolve(out, `panel-${name}.png`) }).then(() => log(`saved panel-${name}.png`));
  await shot("idle");

  await panel.click('[data-src="tab"]');
  await panel.click("#go");
  let st;
  for (let i = 0; i < 20; i++) { st = await state(); if (st.view !== "starting" && st.view !== "ready") break; await sleep(250); }
  check(st.view === "listening" || st.view === "signing", `tab audio started: ${st.view} ${st.pill} ${st.focus} ${st.note}`);
  await sleep(1200);
  await shot("listening");

  const seen = new Set();
  let signing = false, captionOnly = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000 && !(signing && captionOnly && seen.size >= 4)) {
    st = await state();
    for (const c of st.chunks) if (c.text && !seen.has(c.text)) { seen.add(c.text); log(`transcribed (${c.ms} ms audio, ${c.latency_ms} ms rtt): ${c.text}`); }
    if (st.view === "signing" && !signing) { signing = true; log(`signing: ${st.pill} :: ${st.cc}`); await sleep(500); await shot("signing"); }
    if (st.view === "caption_only" && !captionOnly) { captionOnly = true; log(`caption only: ${st.focus} :: ${st.note}`); await sleep(700); await shot("caption-only"); }
    await sleep(200);
  }
  check(seen.size >= 1, `tab audio produced text: ${seen.size} chunks`);
  check(st.phrases.length >= 1, `sign requests answered: ${st.phrases.map((p) => `${p.status}[${p.glosses}]`).join(" | ")}`);
  check(signing, "tab audio speech was signed");
  await panel.click("#go");
  await sleep(400);
  st = await state();
  check(st.view !== "listening", `stop: ${st.view} ${st.pill}`);
  if (!captionOnly) {
    // No unsignable phrase came up in the speech: send one by hand, to show the caption-only state.
    log("no caption-only phrase in this window; injecting one");
    await sleep(3000);
    await panel.evaluate(() => globalThis.__sl.sign("Rice University, Houston, 1962"));
    for (let i = 0; i < 40 && st.view !== "caption_only"; i++) { await sleep(250); st = await state(); }
    check(st.view === "caption_only", `caption only: ${st.focus} :: ${st.note}`);
    await sleep(700);
    await shot("caption-only");
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
