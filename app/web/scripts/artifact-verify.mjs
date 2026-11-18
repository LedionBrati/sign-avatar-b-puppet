// Simulates the claude.ai Artifact host for out/artifact-app and drives it in ONE headless Chrome:
// the page is served wrapped like the host does it (doctype + charset/viewport head + body) under a strict CSP, then
// phone (390x844, dark) and desktop (1440x900, light): home -> type / tap a suggestion -> signing (island + caption
// highlight) -> done, plus the settings and sign-to-speak sheets. Fails on any CSP violation or page error.
//   node scripts/artifact-verify.mjs [shotsDir]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { findChrome } from "../../../shared/find-chrome.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../out/artifact-app");
const shots = path.resolve(process.argv[2] ?? path.join(root, "../artifact-shots"));
fs.mkdirSync(shots, { recursive: true });
const CHROME = findChrome();

const CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; media-src 'self' blob: data:; connect-src 'self'; img-src 'self' data: blob:; worker-src 'none'; manifest-src 'none'";
const TYPES = { ".mp4": "video/mp4", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/") {
    const body = fs.readFileSync(path.join(root, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP });
    return res.end(`<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${body}</body></html>`);
  }
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "content-length": fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const problems = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
try {
  for (const v of [{ name: "phone", w: 390, h: 844, dsf: 2, dark: true, mobile: true }, { name: "desktop", w: 1440, h: 900, dsf: 1, dark: false, mobile: false }]) {
    const page = await browser.newPage();
    await page.setViewport({ width: v.w, height: v.h, deviceScaleFactor: v.dsf, isMobile: v.mobile, hasTouch: v.mobile });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: v.dark ? "dark" : "light" }]);
    await page.evaluateOnNewDocument(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    // The host serves its own favicon; a 404 for it here is the local server, not the page.
    page.on("console", (m) => { if ((m.type() === "error" || /Content Security Policy|Refused/.test(m.text())) && !/favicon/.test(m.location()?.url ?? "")) problems.push(`${v.name} console: ${m.text()} ${m.location()?.url ?? ""}`); });
    page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push(`${v.name} HTTP ${r.status()} ${r.url()}`); });
    page.on("pageerror", (e) => problems.push(`${v.name} pageerror: ${e.message}`));
    page.on("requestfailed", (r) => { if (!/fonts\.g/.test(r.url())) problems.push(`${v.name} requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
    const shot = (n) => page.screenshot({ path: path.join(shots, `${v.name}-${n}.png`) });
    const island = () => page.$eval(".island", (e) => `${e.dataset.state} ${e.textContent}`).catch(() => "?");

    await page.goto(base, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1200));
    await shot("1-home");

    const sentence = v.mobile ? "I feel sick, I need help please." : "Hello friend, good to meet you.";
    if (v.mobile) {
      // Tap a suggestion chip.
      const chips = await page.$$(".suggest .chip");
      if (chips.length !== 6) problems.push(`${v.name}: expected 6 suggestion chips, got ${chips.length}`);
      await chips[0].click();
    } else {
      await page.type(".typebox input", sentence);
      await shot("2-typed");
      await page.click(".typebox button[type=submit]");
    }
    await page.waitForSelector(".island[data-state=sign]", { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 900));
    const signing = await island();
    const nowWord = await page.$eval(".sl-cap .w.now", (e) => e.textContent).catch(() => null);
    const hl = await page.$eval(".sl-cap .hl", (e) => e.classList.contains("show")).catch(() => false);
    const vid = await page.$$eval("video", (vs) => vs.map((x) => ({ src: x.currentSrc.slice(0, 5), t: x.currentTime, rs: x.readyState, op: x.style.opacity })));
    console.log(`${v.name}: signing -> island "${signing}", caption now "${nowWord}", highlight ${hl}, videos ${JSON.stringify(vid)}`);
    if (!nowWord || !hl) problems.push(`${v.name}: no caption highlight while signing`);
    if (!vid.some((x) => x.src === "blob:" && x.t > 0)) problems.push(`${v.name}: no blob video playing`);
    await shot("3-signing");
    await page.waitForSelector(".island[data-state=done]", { timeout: 40000 });
    await new Promise((r) => setTimeout(r, 900));
    console.log(`${v.name}: done -> island "${await island()}"`);
    await shot("4-done");

    // Back home, then the sheets.
    await page.click(".topbar .circbtn");
    await page.waitForSelector(".home", { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 700));
    await page.click(".home .topbar .circbtn");
    await page.waitForSelector(".sheet", { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 700));
    if (await page.$("#api")) problems.push(`${v.name}: server address still shown in settings`);
    await shot("5-settings");
    await page.click(".sheet .textbtn");
    await new Promise((r) => setTimeout(r, 500));
    await page.click("#sign");
    await page.waitForSelector(".sheet .camnote", { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 700));
    await shot("6-sign-to-speak");

    const csp = await page.evaluate(() => window.__csp);
    csp.forEach((c) => problems.push(`${v.name} CSP: ${c}`));
    await page.close();
  }
} catch (e) {
  problems.push(`run: ${e.message}`);
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : `clean: no CSP violations, page errors or failed requests · shots in ${shots}`);
process.exit(problems.length ? 1 : 0);
