// Headless smoke test of Sign -> speak on the web export. Serves dist/ on :8195 (APP_PORT) and the stub embed page
// (scripts/sign-stub.html, a different origin like the real server) on :8196 (STUB_PORT), opens the app with
// ?sign=<stub>, taps "Sign to speak", and checks that the native caption shows the sentence and that
// speech fired (speechSynthesis.speak is recorded). Also shows the error screen for a server without /app/.
//   npx expo export --platform web && node scripts/sign-smoke.mjs
// Env: CHROME (chrome.exe), SERVER (app/server URL, default http://localhost:8787), SIGN (real embed URL to try).
// Saves docs/sign-home.png, docs/sign-live.png, docs/sign-spoken.png, docs/sign-error.png (+ docs/sign-real.png).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2] || path.join(root, "docs");
const APP_PORT = +(process.env.APP_PORT || 8195), STUB_PORT = +(process.env.STUB_PORT || 8196);
const SERVER = process.env.SERVER || "http://localhost:8787";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".ttf": "font/ttf" };
const serve = (dir, port, fallback) => new Promise((r) => {
  const s = http.createServer((req, res) => {
    let f = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dir, fallback);
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream", "access-control-allow-origin": "*" });
    fs.createReadStream(f).pipe(res);
  }).listen(port, () => r(s));
});
const s1 = await serve(path.join(root, "dist"), APP_PORT, "index.html");
const s2 = await serve(path.join(root, "scripts"), STUB_PORT, "sign-stub.html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const page = async () => {
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.evaluateOnNewDocument(() => {
    window.__spoken = [];
    const ss = window.speechSynthesis;
    if (ss) ss.speak = (u) => { window.__spoken.push(u.text); setTimeout(() => { u.onstart?.(); u.onend?.(); }, 50); };
  });
  p.on("pageerror", (e) => console.log("[pageerror]", e.message));
  return p;
};
let fail = 0;
const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) fail++; };
const text = (p, id) => p.$eval(`[data-testid="${id}"]`, (e) => e.textContent).catch(() => null);

// 1. Stub embed page: sentence -> caption, speak -> expo-speech.
const p = await page();
await p.goto(`http://localhost:${APP_PORT}/?server=${SERVER}&sign=${encodeURIComponent(`http://127.0.0.1:${STUB_PORT}/sign-stub.html#/sign?embed=1`)}`, { waitUntil: "networkidle0" });
await sleep(1200);
await p.screenshot({ path: `${out}/sign-home.png` });
await p.click('[data-testid="sign"]');
let mid = false;
for (let t = 0; t < 40; t++) {
  await sleep(150);
  const s = await text(p, "sign-sentence");
  if (!mid && s && s.startsWith("Hello, thank")) { await p.screenshot({ path: `${out}/sign-live.png` }); mid = true; }
  if ((await p.evaluate(() => window.__spoken.length)) > 0) break;
}
await sleep(600);
const spoken = await p.evaluate(() => window.__spoken);
check((await text(p, "sign-sentence")) === "Hello, thank you for coming.", `caption: ${await text(p, "sign-sentence")}`);
check(spoken.length === 1 && spoken[0] === "Hello, thank you for coming.", `speechSynthesis.speak from {type:"speak"}: ${JSON.stringify(spoken)}`);
check((await text(p, "spoken"))?.includes("Last spoken"), `status line: ${await text(p, "spoken")}`);
await p.screenshot({ path: `${out}/sign-spoken.png` });
await p.click('[data-testid="speak"]');
await sleep(900);
await p.click('[data-testid="speak"]');
await sleep(300);
check((await p.evaluate(() => window.__spoken.length)) === 3, `native Speak button speaks again: ${await p.evaluate(() => window.__spoken.length)} total`);

// 2. Real page at <server>/app/ (error screen if the server does not serve it yet).
const q = await page();
const real = process.env.SIGN || `${SERVER}/app/#/sign?embed=1`;
await q.goto(`http://localhost:${APP_PORT}/?server=${SERVER}&sign=${encodeURIComponent(real)}`, { waitUntil: "networkidle0" });
await sleep(800);
await q.click('[data-testid="sign"]');
await sleep(3500);
const errShown = !!(await q.$('[data-testid="sign-error"]'));
console.log(errShown ? `real page ${real}: error screen -> ${await text(q, "sign-error")}` : `real page ${real}: loaded`);
await q.screenshot({ path: `${out}/${errShown ? "sign-error" : "sign-real"}.png` });

// 3. Unreachable server (always the error screen).
const r = await page();
await r.goto(`http://localhost:${APP_PORT}/?server=http://127.0.0.1:9&sign=${encodeURIComponent("http://127.0.0.1:9/app/#/sign?embed=1")}`, { waitUntil: "networkidle0" });
await sleep(800);
await r.click('[data-testid="sign"]');
await sleep(2500);
check(!!(await r.$('[data-testid="sign-error"]')), `unreachable server -> error screen: ${await text(r, "sign-error")}`);
if (!errShown) await r.screenshot({ path: `${out}/sign-error.png` });

await b.close(); s1.close(); s2.close();
process.exit(fail ? 1 : 0);
