// Time the instant player (player.html / src/player.ts) in headless Chrome: avatar + motions load, sentence
// join + solve (bake), and playback fps. Writes a screenshot of the last frame.
//   node puppet/scripts/player-check.mjs [--gpu] [--shot out.png] motion1.json motion2.json ...
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "../../shared/find-chrome.mjs";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const gpu = argv.includes("--gpu");
const shotI = argv.indexOf("--shot");
const shot = shotI !== -1 ? resolve(argv[shotI + 1]) : null;
const files = argv.filter((a, i) => !a.startsWith("--") && i !== shotI + 1).map((f) => resolve(f));
if (!files.length) { console.error("usage: player-check.mjs [--gpu] [--shot x.png] a.json b.json ..."); process.exit(1); }

const chrome = findChrome();
const { createServer } = await import("vite");
const server = await createServer({ root: here, configFile: join(here, "vite.config.ts"), logLevel: "error", server: { port: 5191, strictPort: false, host: "127.0.0.1" } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const puppeteer = (await import("puppeteer-core")).default;
const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  args: [...(gpu ? ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]), "--no-first-run"],
  defaultViewport: { width: 600, height: 860 },
});
try {
  const page = await browser.newPage();
  // warm the dev server's module transform once, so the timing is the player's, not vite's first compile
  await page.goto(`${base}/player.html?signs=${encodeURIComponent(files[0])}`, { waitUntil: "load" });
  await page.evaluate(() => window.playerStats).catch(() => {});
  const url = `${base}/player.html?signs=${encodeURIComponent(files.join(","))}`;
  await page.goto(url, { waitUntil: "load" });
  const stats = await page.evaluate(() => window.playerStats);
  console.log(JSON.stringify({ webgl: gpu ? "hardware" : "software", signs: files.length, ...stats }));
  if (shot) { mkdirSync(dirname(shot), { recursive: true }); await (await page.$("canvas")).screenshot({ path: shot }); console.log(`wrote ${shot}`); }
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  try { browser.process()?.kill("SIGKILL"); } catch {}
  await server.close().catch(() => {});
  process.exit(0);
}
