// Design QA for the cobalt glass UI: Home, Settings, the floating Live card (typed sentences, sizes, drag), the
// docked phone card, Sign -> speak, and the light variant. Also checks that dragging the card moves it and that the
// position is remembered.
//   npx vite --port 5199   then   node scripts/shots-glass.mjs
// Env: APP_URL (default http://127.0.0.1:5199/), OUT (default screenshots/), ONLY (comma list: home settings live
// drag sizes phone sign light), CHROME.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const APP = process.env.APP_URL ?? "http://127.0.0.1:5199/";
const OUT = process.env.OUT ?? path.resolve(import.meta.dirname, "../screenshots");
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const want = (n) => !ONLY || ONLY.has(n);
const CHROME = process.env.CHROME ?? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
const DESK = { width: 1440, height: 900, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 90_000;

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--disable-renderer-backgrounding"],
});
const errors = [];
const results = [];
try {
  const open = async (view, theme = "dark") => {
    const page = await browser.newPage();
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setViewport(view);
    await page.goto(APP, { waitUntil: "networkidle2" });
    await page.evaluate((t) => { localStorage.clear(); localStorage.setItem("sl-prefs", JSON.stringify({ theme: t, captions: true })); }, theme);
    await page.reload({ waitUntil: "networkidle2" });
    await sleep(1200);
    return page;
  };
  const shot = async (page, name) => { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }); console.log("saved", path.basename(f)); };
  const typeOnHome = async (page, text) => {
    await page.click("#type");
    await sleep(300);
    await page.type(".typebox input", text);
    await page.keyboard.press("Enter");
  };
  const waitSigning = (page) => page.waitForSelector(".island-detail", { timeout: T }).catch(() => console.log("  (no signing seen)"));
  const waitDone = (page) => page.waitForSelector(".sumline", { timeout: T }).catch(() => console.log("  (not done in time)"));

  // ── Desktop ──
  if (want("home") || want("settings") || want("live") || want("drag") || want("sizes")) {
    const page = await open(DESK);
    if (want("home")) await shot(page, "home-desktop");
    if (want("settings")) {
      await page.click('button[aria-label="Settings"]');
      await sleep(900);
      await shot(page, "settings-desktop");
      await page.click(".sheet .textbtn");
      await sleep(500);
    }
    if (want("live") || want("drag") || want("sizes")) {
      await typeOnHome(page, "hello thank you");
      await sleep(1400);
      await shot(page, "live-listening-desktop");
      await waitSigning(page);
      await sleep(500);
      await shot(page, "live-hello-desktop");
      await waitDone(page);
      await sleep(900);
      await shot(page, "live-done-desktop");

      if (want("drag")) {
        const box0 = await page.$eval(".fcard", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
        const head = await page.$eval(".fc-sp", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await page.mouse.move(head.x, head.y);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) { await page.mouse.move(head.x - 42 * i, head.y + 6 * i); await sleep(16); }
        await page.mouse.up();
        await sleep(700);
        const box1 = await page.$eval(".fcard", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y }; });
        const saved = await page.evaluate(() => localStorage.getItem("sl-float"));
        const moved = Math.round(box1.x - box0.x), movedY = Math.round(box1.y - box0.y);
        results.push(`drag: card moved dx=${moved} dy=${movedY} (asked -420/+60) · saved ${saved}`);
        await shot(page, "live-dragged-desktop");
        // Far past the edge: must stay inside the viewport.
        const h2 = await page.$eval(".fc-sp", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await page.mouse.move(h2.x, h2.y); await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(h2.x - 400 * i, h2.y + 300 * i); await sleep(16); }
        await page.mouse.up(); await sleep(700);
        const b2 = await page.$eval(".fcard", (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
        results.push(`clamp: card at l=${Math.round(b2.l)} t=${Math.round(b2.t)} r=${Math.round(b2.r)} b=${Math.round(b2.b)} in 1440x900`);
        // Keyboard move + remembered after reload
        await page.focus(".fc-grip");
        await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowUp");
        await sleep(600);
        const b3 = await page.$eval(".fcard", (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; });
        results.push(`keys: card now at ${b3.x},${b3.y} (was ${Math.round(b2.l)},${Math.round(b2.t)})`);
      }
      if (want("sizes")) {
        await page.click('.fcard .seg button:nth-of-type(3)'); // L
        await sleep(900);
        await shot(page, "live-size-l-desktop");
        await page.click('.fcard .seg button:nth-of-type(1)'); // S
        await sleep(900);
        await shot(page, "live-size-s-desktop");
        await page.click('.fcard .seg button:nth-of-type(2)'); // M
        await sleep(700);
      }
      // A second sentence typed inside the card.
      await page.click("#typebtn");
      await sleep(400);
      await shot(page, "live-typing-desktop");
      await page.type(".fcard .typebox input", "where is the bathroom");
      await page.keyboard.press("Enter");
      await sleep(600);
      await page.waitForFunction(() => document.querySelector(".island-detail"), { timeout: T }).catch(() => {});
      await sleep(400);
      await shot(page, "live-bathroom-desktop");
      await waitDone(page);
      await sleep(800);
      await shot(page, "live-bathroom-done-desktop");
    }
    await page.close();
  }

  // ── Phone ──
  if (want("phone")) {
    const page = await open(PHONE);
    await shot(page, "home-phone");
    await typeOnHome(page, "where is the bathroom");
    await sleep(1400);
    await shot(page, "live-listening-phone");
    await waitSigning(page);
    await sleep(400);
    await shot(page, "live-bathroom-phone");
    await waitDone(page);
    await sleep(800);
    await shot(page, "live-done-phone");
    const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll(".fcard *")].some((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest(".fc-wave, .fc-aura")));
    results.push(`phone overflow: ${over}`);
    await page.click('button[aria-label="Close"]');
    await sleep(600);
    await page.click('button[aria-label="Settings"]');
    await sleep(900);
    await shot(page, "settings-phone");
    await page.close();
  }

  // ── Sign -> speak ──
  if (want("sign")) {
    const page = await open(DESK);
    await page.goto(`${APP}#/sign`, { waitUntil: "networkidle2" });
    await sleep(6000);
    await shot(page, "sign-desktop");
    await page.close();
    const p2 = await open(PHONE);
    await p2.goto(`${APP}#/sign`, { waitUntil: "networkidle2" });
    await sleep(5000);
    await shot(p2, "sign-phone");
    await p2.close();
  }

  // ── Light variant ──
  if (want("light")) {
    const page = await open(DESK, "light");
    await shot(page, "home-desktop-light");
    await typeOnHome(page, "hello thank you");
    await waitSigning(page);
    await sleep(500);
    await shot(page, "live-hello-desktop-light");
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(results.join("\n"));
if (errors.length) console.log("console errors:\n" + [...new Set(errors)].slice(0, 15).join("\n"));
