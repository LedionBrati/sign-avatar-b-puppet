// Render the PWA PNG icons from public/icon.svg and public/icon-maskable.svg with headless Chrome.
//   node scripts/icons.mjs
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const pub = path.resolve(import.meta.dirname, "../public");
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const jobs = [
  ["icon.svg", 192, "icon-192.png", true],
  ["icon.svg", 512, "icon-512.png", true],
  ["icon-maskable.svg", 512, "icon-maskable-512.png", false],
  ["icon-maskable.svg", 180, "icon-180.png", false], // iOS rounds the corners itself
];
for (const [src, size, out, transparent] of jobs) {
  const svg = fs.readFileSync(path.join(pub, src), "utf8");
  await page.setViewport({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(pub, out), omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  console.log("wrote", out);
}
await browser.close();
