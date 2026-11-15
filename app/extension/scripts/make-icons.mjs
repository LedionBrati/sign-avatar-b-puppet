// Renders the SIGNLAYER mark (app/core tokens MARK_SVG) to public/icon/{16,32,48,128}.png with Chrome.
//   node scripts/make-icons.mjs
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = await readFile(resolve(root, "../core/src/tokens.ts"), "utf8");
const svg = tokens.match(/MARK_SVG = `([^`]+)`/)[1];
const out = resolve(root, "public/icon");
await mkdir(out, { recursive: true });

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: resolve(out, `${size}.png`), omitBackground: true });
}
await browser.close();
console.log("icons ->", out);
