// End-to-end check of the floating card with Tab audio, in real Chrome:
//   a local page plays a speech recording (started by a real click) -> the toolbar action is clicked (injects the
//   card, grants activeTab) -> drag the card -> Start -> the offscreen document captures the tab, chunks reach
//   /api/transcribe -> text -> /api/sign -> the signer plays -> Stop -> size -> toolbar click again closes it.
//   Then the same on a dark page, and a Chrome page (the card can't open there: the icon says so).
// Screenshots: screenshots/{light,dark}-*.png (whole viewport) and *-card.png (close-up).
//
//   npm run build && AUDIO=path/to/speech.wav node scripts/verify.mjs
//   env: SIGNLAYER_API (default http://localhost:8787; needs transcribe "ready"), SEEK=seconds into the audio,
//        OUT=dir (default screenshots), HEADFUL=1
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
const out = process.env.OUT ?? resolve(root, "screenshots");
const PORT = 8799;
const VW = 1280, VH = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!audio) throw new Error("AUDIO=path/to/speech (any spoken English recording)");

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failed = true; };

const mime = { ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "audio/webm" }[extname(audio)] ?? "application/octet-stream";
const para = (n) => Array.from({ length: n }, (_, i) => `<p>${[
  "We set sail on this new sea because there is new knowledge to be gained, and new rights to be won, and they must be won and used for the progress of all people.",
  "No nation which expects to be the leader of other nations can expect to stay behind in the race for space. Those who came before us made certain that this country rode the first waves of the industrial revolution.",
  "The exploration of space will go ahead, whether we join in it or not, and it is one of the great adventures of all time.",
][i % 3]}</p>`).join("");
const play = `<script>document.getElementById("play").onclick = () => { const a = document.getElementById("a"); a.currentTime = ${seek}; a.play(); };
document.addEventListener("click", (e) => { window.__clicks = (window.__clicks || 0) + 1; });</script>`;
const LIGHT = `<!doctype html><meta charset="utf-8"><title>The Moon Speech · Archive</title>
<style>
  body { margin: 0; font: 17px/1.6 Georgia, serif; color: #1d1d1f; background: #fbfaf7; }
  nav { display: flex; gap: 24px; align-items: center; padding: 14px 48px; border-bottom: 1px solid #e6e3dc; font: 600 14px system-ui; background: #fff; }
  nav b { font: 800 20px Georgia; margin-right: auto; }
  main { display: grid; grid-template-columns: 1fr 300px; gap: 48px; max-width: 1180px; margin: 0 auto; padding: 36px 48px; }
  h1 { font: 700 44px/1.1 Georgia; margin: 0 0 12px; letter-spacing: -.02em; }
  .kicker { font: 700 12px system-ui; letter-spacing: .14em; text-transform: uppercase; color: #c2410c; }
  .hero { height: 260px; border-radius: 14px; margin: 22px 0; background: radial-gradient(40% 60% at 70% 40%, #ffd28a, transparent 70%), linear-gradient(120deg, #ff7a59, #f9b44c 40%, #5ab0ff); }
  .player { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border: 1px solid #e6e3dc; border-radius: 12px; background: #fff; font: 15px system-ui; }
  #play { width: 44px; height: 44px; border-radius: 50%; border: 0; background: #c2410c; color: #fff; font-size: 16px; cursor: pointer; }
  aside { font: 15px/1.5 system-ui; color: #4a4a4f; } aside h3 { font: 700 13px system-ui; letter-spacing: .12em; text-transform: uppercase; color: #1d1d1f; }
  aside .tile { height: 120px; border-radius: 10px; margin-bottom: 14px; background: linear-gradient(135deg, #1f8a70, #bedb39); }
</style>
<nav><b>The Archive</b><span>Speeches</span><span>History</span><span>Science</span><span>Subscribe</span></nav>
<main><article><div class="kicker">Rice University · 1962</div><h1>We choose to go to the Moon</h1>
<div class="player"><button id="play" aria-label="Play">▶</button><div><b>Listen to the speech</b><br><span style="color:#777">John F. Kennedy · public domain</span></div><audio id="a" src="/speech" loop></audio></div>
<div class="hero"></div>${para(5)}</article>
<aside><h3>Related</h3><div class="tile"></div><p>Apollo 11: the landing, minute by minute.</p><div class="tile" style="background:linear-gradient(135deg,#6d28d9,#f472b6)"></div><p>The engineers behind the Saturn V.</p></aside></main>${play}`;
const DARK = `<!doctype html><meta charset="utf-8"><title>Rice University speech · Video</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui; color: #f1f1f1; background: #0f0f0f; }
  header { display: flex; align-items: center; gap: 18px; padding: 12px 24px; }
  header b { font: 800 19px system-ui; color: #ff3d3d; } header .q { flex: 0 1 520px; margin: 0 auto; height: 38px; border-radius: 20px; background: #222; border: 1px solid #303030; }
  main { display: grid; grid-template-columns: 1fr 380px; gap: 24px; padding: 8px 24px; }
  .video { aspect-ratio: 16 / 9; border-radius: 14px; position: relative; overflow: hidden;
    background: radial-gradient(30% 40% at 30% 40%, #3b82f6aa, transparent 70%), radial-gradient(40% 50% at 75% 60%, #f59e0baa, transparent 70%), linear-gradient(160deg, #1e293b, #020617); }
  .video button { position: absolute; left: 50%; top: 50%; translate: -50% -50%; width: 74px; height: 52px; border-radius: 14px; border: 0; background: #ff3d3d; color: #fff; font-size: 22px; cursor: pointer; }
  h1 { font: 700 21px system-ui; margin: 14px 0 6px; } .meta { color: #aaa; }
  .side div { display: grid; grid-template-columns: 168px 1fr; gap: 10px; margin-bottom: 12px; color: #ccc; }
  .side i { height: 94px; border-radius: 10px; background: linear-gradient(135deg, #7c3aed, #0ea5e9); } .side div:nth-child(2) i { background: linear-gradient(135deg, #f43f5e, #f59e0b); } .side div:nth-child(3) i { background: linear-gradient(135deg, #10b981, #3b82f6); }
</style>
<header><b>▶ Tube</b><span class="q"></span></header>
<main><section><div class="video"><button id="play" aria-label="Play">▶</button><audio id="a" src="/speech" loop></audio></div>
<h1>"We choose to go to the Moon": full speech at Rice University</h1><div class="meta">1.2M views · 1962 · public domain</div></section>
<aside class="side"><div><i></i><span>Apollo 11 landing, restored in 4K</span></div><div><i></i><span>How the Saturn V works</span></div><div><i></i><span>Mission control audio, 1969</span></div></aside></main>${play}`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/speech") return res.writeHead(200, { "content-type": mime }).end(await readFile(audio));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/dark" ? DARK : LIGHT);
  } catch { res.writeHead(500).end(); }
});
await new Promise((r) => server.listen(PORT, r));
await mkdir(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: process.env.HEADFUL ? false : "new",
  defaultViewport: null,
  enableExtensions: true,
  // Never audible: --disable-audio-output sends all audio to fake output streams (nothing reaches the speakers) while
  // the tab still produces audio for tab capture. (--mute-audio can't be used: a muted tab captures as silence.)
  ignoreDefaultArgs: ["--mute-audio"],
  args: ["--disable-audio-output", "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "--lang=en-US"],
});
try {
  const extId = await browser.installExtension(ext);
  const sw = await (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(extId), { timeout: 15000 })).worker();
  await sw.evaluate((apiUrl) => chrome.storage.local.set({ apiUrl, source: "tab", size: "m" }).then(() => chrome.storage.local.remove("floatPos")), api);
  const extension = (await browser.extensions()).get(extId);
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: VW, height: VH, deviceScaleFactor: 2 });
  const hostCount = () => page.evaluate(() => document.querySelectorAll("signlayer-float").length);
  const capturing = () => sw.evaluate(() => chrome.storage.session.get("capturing").then((r) => r.capturing ?? null));

  const open = async () => {
    const f = page.waitForFrame((fr) => fr.url().includes(`${extId}/overlay.html`), { timeout: 8000 }).catch(() => null);
    await extension.triggerAction(page);
    const frame = await f;
    if (frame) await frame.waitForFunction(() => document.getElementById("pill")?.textContent?.trim(), { timeout: 8000 }).catch(() => {});
    return frame;
  };
  const cardBox = async (frame) => (await frame.frameElement())?.boundingBox();
  const shots = async (name, frame) => {
    await page.screenshot({ path: resolve(out, `${name}.png`) });
    const b = await cardBox(frame);
    if (b) {
      const x = Math.max(0, b.x - 40), y = Math.max(0, b.y - 40);
      await page.screenshot({ path: resolve(out, `${name}-card.png`), clip: { x, y, width: Math.min(VW - x, b.width + 80), height: Math.min(VH - y, b.height + 80) } });
    }
    log(`saved ${name}.png, ${name}-card.png`);
  };
  const state = (frame) => frame.evaluate(() => ({
    view: document.body.dataset.state, pill: document.getElementById("pill").textContent.replace(/\s+/g, " ").trim(),
    cc: document.getElementById("cc").textContent.replace(/\s+/g, " ").trim(),
    note: document.getElementById("note").textContent.trim(),
    chunks: globalThis.__slTab?.chunks ?? [], phrases: globalThis.__sl?.phrases ?? [],
  }));
  /** Start listening, wait until it signs (or time out). */
  const listen = async (frame, name, { captionShot = false } = {}) => {
    await frame.click("#go");
    let st;
    for (let i = 0; i < 30; i++) { st = await state(frame); if (st.view !== "starting" && st.view !== "ready") break; await sleep(250); }
    check(st.view === "listening" || st.view === "signing", `${name}: tab audio started: ${st.view} | ${st.pill} | ${st.note}`);
    await sleep(1500);
    await shots(`${name}-listening`, frame);
    const seen = new Set();
    let signing = false, captionOnly = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 45000 && !(signing && (captionOnly || !captionShot) && seen.size >= 3)) {
      st = await state(frame);
      for (const c of st.chunks) if (c.text && !seen.has(c.text)) { seen.add(c.text); log(`transcribed (${c.ms} ms audio, ${c.latency_ms} ms rtt): ${c.text}`); }
      if (st.view === "signing" && !signing) { signing = true; log(`signing: ${st.pill} :: ${st.cc}`); await sleep(500); await shots(`${name}-signing`, frame); }
      if (captionShot && !captionOnly && st.phrases.some((p) => p.status !== "fully_supported")) { captionOnly = true; log(`not signed (signer stays still): ${st.cc}`); await sleep(700); await shots(`${name}-caption-only`, frame); }
      await sleep(200);
    }
    check(seen.size >= 1, `${name}: tab audio produced text: ${seen.size} chunks`);
    check(st.phrases.length >= 1, `${name}: sign requests answered: ${st.phrases.map((p) => `${p.status}[${p.glosses}]`).join(" | ")}`);
    check(st.phrases.some((p) => p.status === "fully_supported"), `${name}: a phrase came back fully_supported`);
    check(signing, `${name}: tab audio speech was signed, captions under the signer`);
    return { captionOnly };
  };
  const drag = async (from, dx, dy) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10); await sleep(16); }
    await page.mouse.up();
    await sleep(300);
  };

  // ── Light page ──
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
  await page.click("#play"); // a real click plays the page; no autoplay flags
  const tabId = await sw.evaluate(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0]?.id));
  let frame = await open();
  check(!!frame && (await hostCount()) === 1, "toolbar click injected the floating card");
  await sleep(2500);
  await shots("light-idle", frame);

  // Drag by the header (real mouse events into the card's iframe).
  const b0 = await cardBox(frame);
  await drag({ x: b0.x + 50, y: b0.y + 22 }, -260, 90);
  const b1 = await cardBox(frame);
  check(Math.abs(b1.x - (b0.x - 260)) < 6 && Math.abs(b1.y - (b0.y + 90)) < 6, `drag moved the card: (${Math.round(b0.x)},${Math.round(b0.y)}) -> (${Math.round(b1.x)},${Math.round(b1.y)})`);
  const pos = await sw.evaluate(() => chrome.storage.local.get("floatPos").then((r) => r.floatPos));
  check(!!pos, `position remembered: ${JSON.stringify(pos)}`);
  await drag({ x: b1.x + 50, y: b1.y + 22 }, 1500, -600);
  const b2 = await cardBox(frame);
  check(b2.x + b2.width <= VW - 7 && b2.y >= 7, `kept inside the viewport: (${Math.round(b2.x)},${Math.round(b2.y)}) ${Math.round(b2.width)}x${Math.round(b2.height)}`);
  await page.mouse.click(300, 600);
  check((await page.evaluate(() => window.__clicks)) >= 1, "a click outside the card reaches the page");

  const { captionOnly } = await listen(frame, "light", { captionShot: true });
  await frame.click("#go");
  await sleep(500);
  let st = await state(frame);
  check(st.view !== "listening", `stop: ${st.view} | ${st.pill}`);
  check((await capturing()) === null, "capture released after Stop");
  if (!captionOnly) {
    log("no caption-only phrase in this window; injecting one");
    await sleep(2500);
    await frame.evaluate(() => globalThis.__sl.sign("Rice University, Houston, 1962"));
    for (let i = 0; i < 40 && !/Houston/.test(st.cc); i++) { await sleep(250); st = await state(frame); }
    check(/Houston/.test(st.cc) && st.view !== "signing" && !st.note, `not signed, no popup, transcript keeps the words: ${st.view} :: ${st.cc}`);
    await sleep(700);
    await shots("light-caption-only", frame);
  }

  // Size: M -> L -> S -> M.
  const w = [];
  await frame.click("#gear");
  await sleep(300);
  for (let i = 0; i < 3; i++) { await frame.click(`#size [data-size="${["l", "s", "m"][i]}"]`); await sleep(400); w.push(Math.round((await cardBox(frame)).width)); if (i < 2) await shots(`light-size-${i ? "s" : "l"}`, frame); }
  check(w[0] > w[2] && w[2] > w[1], `size (gear menu): L ${w[0]}px, S ${w[1]}px, M ${w[2]}px`);
  await frame.click("#gear");

  // Toolbar click again: the card closes.
  await extension.triggerAction(page);
  await sleep(600);
  check((await hostCount()) === 0, "second toolbar click closed the card");

  // ── Dark page ──
  await page.goto(`http://localhost:${PORT}/dark`, { waitUntil: "load" });
  await page.click("#play");
  frame = await open();
  check(!!frame, "card opened on the dark page, at the remembered position");
  await sleep(2500);
  await shots("dark-idle", frame);
  await listen(frame, "dark");
  await frame.click("#close");
  await sleep(700);
  check((await hostCount()) === 0, "close button removed the card");
  check((await capturing()) === null, "capture released after close");

  // ── A Chrome page: nothing injected, the icon says why ──
  await page.goto("chrome://version", { waitUntil: "load" }).catch(() => {});
  await extension.triggerAction(page).catch((e) => log("triggerAction on chrome://", String(e).slice(0, 80)));
  await sleep(800);
  const badge = await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId).catch((e) => `err ${e}`);
  check(badge === "!", `chrome:// page: no card, badge "${badge}"`);
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
