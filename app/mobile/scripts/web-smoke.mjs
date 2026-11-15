// Headless smoke test of the web export in typed mode: Home -> type "Thank you, see you later." -> plays -> Done.
// Saves docs/home.png, docs/live.png, docs/done.png. Needs puppeteer-core (npm i -g puppeteer-core or npx) and Chrome.
//   npx expo export --platform web && node <static server for dist on :8095> && node scripts/web-smoke.mjs
// Env: CHROME (chrome.exe path), APP (where dist is served), SERVER (app/server URL).
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
const out = process.argv[2] || fileURLToPath(new URL("../docs", import.meta.url));
const b = await puppeteer.launch({ executablePath: process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const logs = [];
p.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await p.goto(`${process.env.APP || "http://localhost:8095"}/?server=${process.env.SERVER || "http://localhost:8787"}`, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1500));
await p.screenshot({ path: `${out}/home.png` });
await p.click('[data-testid="listen"]');
await new Promise((r) => setTimeout(r, 800));

await p.type('[data-testid="type-input"]', "Thank you, see you later.");
await p.keyboard.press("Enter");
let mid = false;
for (let t = 0; t < 120; t++) {
  await new Promise((r) => setTimeout(r, 250));
  const now = await p.$eval('[data-testid="nowline"]', (e) => e.textContent).catch(() => null);
  if (!mid && now && now.includes("SEE")) { await new Promise((r) => setTimeout(r, 500)); await p.screenshot({ path: `${out}/live.png` }); mid = true; console.log("mid:", now); }
  const sum = await p.$('[data-testid="summary"]');
  if (sum) { await new Promise((r) => setTimeout(r, 700)); await p.screenshot({ path: `${out}/done.png` }); console.log("done:", await p.$eval('[data-testid="summary"]', (e) => e.textContent)); break; }
  if (t % 8 === 0) console.log("t", t, now);
}
console.log(logs.slice(0, 30).join("\n"));
await b.close();
