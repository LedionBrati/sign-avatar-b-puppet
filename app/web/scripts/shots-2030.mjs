// Design QA for the 2030 UI: every screen in light + dark, at iPhone (390x844) and desktop (1440x900) sizes,
// plus a playback trace of typed signing that flags seams (frozen stretches, frames with no opaque video).
//   npm run dev   then   node scripts/shots-2030.mjs
// Env: APP_URL (default http://localhost:5173), OUT (default docs/), PREFIX (default "2030-"), ONLY (comma list of
// screen names: home settings listening live done hints offline nospeech sign), THEMES ("dark,light"), SIZES ("phone,desktop"), TEXT, DPR (phone, default 2), WAIT_MS, REC=1 (also save screencast frames to OUT/rec).
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const APP = process.env.APP_URL ?? "http://localhost:5173";
const OUT = process.env.OUT ?? path.resolve(import.meta.dirname, "../docs");
const PREFIX = process.env.PREFIX ?? "2030-";
const TEXT = process.env.TEXT ?? "I feel sick, I need help please.";
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const THEMES = (process.env.THEMES ?? "dark,light").split(",");
const SIZES = (process.env.SIZES ?? "phone,desktop").split(",");
const DPR = +(process.env.DPR ?? 2);
const VIEW = { phone: { width: 390, height: 844, deviceScaleFactor: DPR, isMobile: true, hasTouch: true }, desktop: { width: 1440, height: 900, deviceScaleFactor: 1 } };
const CHROME = process.env.CHROME ?? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
const want = (n) => !ONLY || ONLY.has(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--disable-renderer-backgrounding"],
});
const errors = [];
try {
  for (const size of SIZES) for (const theme of THEMES) {
    const page = await browser.newPage();
    page.on("console", (m) => m.type() === "error" && errors.push(`[${size}/${theme}] ${m.text()}`));
    page.on("pageerror", (e) => errors.push(`[${size}/${theme}] ${e}`));
    await page.setViewport(VIEW[size]);
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
    const shot = async (name) => { const f = path.join(OUT, `${PREFIX}${name}-${size}-${theme}.png`); await page.screenshot({ path: f }); console.log("saved", path.basename(f)); };

    await page.goto(APP, { waitUntil: "networkidle0" });
    await page.evaluate(() => localStorage.removeItem("sl-prefs"));
    await page.reload({ waitUntil: "networkidle0" });
    await sleep(1200);
    if (want("home")) await shot("home");

    if (want("settings")) {
      await page.click('button[aria-label="Settings"]');
      await sleep(900);
      await shot("settings");
      await page.click(".sheet .textbtn");
      await sleep(500);
    }

    if (want("live") || want("listening") || want("done")) {
      await page.click("#type");
      await sleep(400);
      await page.type(".typebox input", TEXT);
      await page.keyboard.press("Enter");
      await sleep(1300);
      if (want("listening")) await shot("listening");
      await page.evaluate(() => {
        window.__trace = [];
        const tick = () => {
          const vs = [...document.querySelectorAll(".sl-signer video")];
          const front = vs.find((v) => v.classList.contains("front"));
          const op = vs.map((v) => (v.readyState >= 2 ? +getComputedStyle(v).opacity : 0)); // a video with no decoded frame shows nothing
          window.__trace.push({ t: performance.now(), src: front?.currentSrc.slice(-12) ?? "", ct: front?.currentTime ?? 0, paused: front?.paused ?? true, op, island: document.querySelector(".island")?.textContent ?? "" });
          if (!document.querySelector(".sumline")) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const mid = process.env.MID ?? "SICK";
      const T = +(process.env.WAIT_MS ?? 120000);
      await page.waitForFunction((w) => document.querySelector(".island-detail")?.textContent === w, { timeout: T }, mid).catch(() => console.log("  (mid word not reached)"));
      await sleep(650);
      if (want("live")) await shot("live");
      await page.waitForSelector(".sumline", { timeout: T }).catch(() => console.log("  (not done in time)"));
      await sleep(1000);
      if (want("done")) await shot("done");
      const trace = await page.evaluate(() => window.__trace);
      let stall = 0, see = 0;
      let opened = false;
      for (let i = 1; i < trace.length; i++) {
        const a = trace[i - 1], b = trace[i];
        if (a.src && a.src === b.src && a.ct === b.ct && !b.paused) stall = Math.max(stall, b.t - a.t);
        if (b.op.some((o) => o > 0.99)) opened = true;
        else if (opened) see++;
      }
      const starts = trace.filter((x, i, arr) => x.src && x.src !== arr[i - 1]?.src).map((x) => `${x.src.replace(/^.*\//, "")}@${((x.t - trace[0].t) / 1000).toFixed(2)}`);
      console.log(`[${size}/${theme}] clips:`, starts.join(" → "));
      console.log(`[${size}/${theme}] longest frozen stretch while playing: ${stall.toFixed(0)} ms · frames with no opaque, decoded video after start (see-through): ${see}`);
      await page.click("#stop").catch(() => {});
    }

    if (want("hints")) {
      // Words with no sign yet: muted + dotted in the captions, named under them.
      await page.goto(APP, { waitUntil: "networkidle0" });
      await page.click("#type");
      await page.type(".typebox input", "Turn right at the bank, my name is Zork.");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".sumline", { timeout: +(process.env.WAIT_MS ?? 120000) }).catch(() => {});
      await sleep(900);
      await shot("hints");
    }

    if (want("offline")) {
      // Sign server unreachable: banner + caption-only card.
      await page.goto(APP, { waitUntil: "networkidle0" });
      await page.evaluate(() => localStorage.setItem("sl-api", "http://127.0.0.1:9"));
      await page.reload({ waitUntil: "networkidle0" });
      await page.click("#type");
      await page.type(".typebox input", "Where is the train station?");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".banner", { timeout: 20000 }).catch(() => {});
      await sleep(1500);
      await shot("offline");
      await page.evaluate(() => localStorage.removeItem("sl-api"));
    }

    if (want("nospeech")) {
      // Browsers without speech recognition (Firefox, iOS home-screen PWA): typing is the way in.
      const p2 = await browser.newPage();
      await p2.setViewport(VIEW[size]);
      await p2.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      await p2.evaluateOnNewDocument(() => { delete window.webkitSpeechRecognition; delete window.SpeechRecognition; });
      await p2.goto(APP, { waitUntil: "networkidle0" });
      await sleep(1200);
      const f = path.join(OUT, `${PREFIX}nospeech-${size}-${theme}.png`);
      await p2.screenshot({ path: f });
      console.log("saved", path.basename(f));
      await p2.close();
    }

    if (want("sign")) {
      await page.goto(`${APP}/#/sign`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.querySelector(".island")?.textContent?.startsWith("Ready"), { timeout: 30000 }).catch(() => {});
      await sleep(1200);
      await shot("sign");
      // A result state without a real signer: inject a recognition into the history UI through the API mock is not
      // possible here, so show the sentence editor with typed text instead.
      await page.click(".sentence textarea");
      await page.keyboard.type("Hello, I need help.");
      await sleep(400);
      await shot("sign-sentence");
    }
    await page.close();
  }

  if (process.env.REC === "1") {
    // Screencast frames of typed signing (phone, dark) to eyeball seams frame by frame.
    const dir = path.join(OUT, "rec");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await page.goto(APP, { waitUntil: "networkidle0" });
    await sleep(800);
    const cdp = await page.createCDPSession();
    let n = 0;
    const meta = [];
    cdp.on("Page.screencastFrame", async (f) => {
      const file = path.join(dir, `f${String(n++).padStart(4, "0")}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, "base64"));
      meta.push({ file: path.basename(file), t: f.metadata.timestamp });
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await page.click("#type");
    await page.type(".typebox input", TEXT);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
    await page.keyboard.press("Enter");
    await page.waitForSelector(".sumline", { timeout: 120000 });
    await sleep(600);
    await cdp.send("Page.stopScreencast");
    fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify(meta));
    console.log(`recorded ${n} frames to ${dir}`);
    await page.close();
  }
} finally {
  if (errors.length) console.log("console errors:\n  " + [...new Set(errors)].slice(0, 20).join("\n  "));
  await browser.close();
}
