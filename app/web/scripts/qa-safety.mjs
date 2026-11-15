// Browser smoke test against the real local API and a test-only clip manifest.
// Run make-qa-clips.mjs first, then start the API and web dev server as in the QA report.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const appUrl = process.env.APP_URL ?? "http://127.0.0.1:5173/";
const shots = resolve(process.env.QA_SHOTS_DIR ?? "../../out/qa-logs/browser");
await mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: "new",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const pause = () => new Promise((r) => setTimeout(r, 850));
const input = 'input[aria-label="Text to sign"]';
const send = async (message) => { await page.type(input, message); await page.click(".typebox button"); };

try {
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(appUrl, { waitUntil: "networkidle2" });
  await page.click("#type");
  assert.equal(await page.$eval(".typebox button", (el) => el.disabled), true, "empty text must not submit");

  await send("Hello, thank you.");
  await page.waitForFunction(() => document.querySelector(".sumline")?.textContent?.includes("2 signs"), { timeout: 12000 });
  assert.equal(await page.$eval(".sumline", (el) => el.textContent.includes("Signed")), true);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("video")].some((v) => v.readyState >= 2)), true);
  await pause();
  await page.screenshot({ path: resolve(shots, "supported.png") });
  console.log("PASS supported message played two synthetic clips");

  await page.click(".footrow .textlink");
  await send("I don't want that.");
  await page.waitForFunction(() => document.querySelector(".safety-card")?.textContent?.includes("I don't want that."));
  assert.equal(await page.$eval(".safety-card", (el) => el.textContent.includes("Caption only")), true);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("video")].map((v) => v.getAttribute("src"))), [null, null]);
  await pause();
  await page.screenshot({ path: resolve(shots, "caption-only.png") });
  console.log("PASS negation blocked with full caption and empty video queue");

  await send("Turn right at the bank.");
  await page.waitForFunction(() => document.querySelector(".safety-card")?.textContent?.includes("Meaning needs confirmation"));
  assert.equal(await page.$eval(".safety-card", (el) => el.textContent.includes("Turn right at the bank.")), true);
  assert.equal(await page.$(".hint"), null, "an earlier unsupported hint must not leak");
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("video")].map((v) => v.getAttribute("src"))), [null, null]);
  await pause();
  await page.screenshot({ path: resolve(shots, "needs-confirmation.png") });
  console.log("PASS ambiguity blocked with full caption and no stale hint or video");

  await send("Yes, thank you.");
  await page.waitForFunction(() => document.querySelector(".sumline")?.textContent?.includes("2 signs") && !document.querySelector(".safety-card"), { timeout: 12000 });
  await pause();
  await page.screenshot({ path: resolve(shots, "recovered.png") });
  console.log("PASS supported playback resumed after blocked messages");

  await page.setRequestInterception(true);
  const intercept = (request) => request.url().endsWith("/api/sign") ? request.abort("failed") : request.continue();
  page.on("request", intercept);
  await send("Hello, thank you.");
  await page.waitForFunction(() => document.querySelector(".safety-card")?.textContent?.includes("server could not be reached"), { timeout: 7000 });
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("video")].map((v) => v.getAttribute("src"))), [null, null]);
  page.off("request", intercept);
  await page.setRequestInterception(false);
  await send("No, thank you.");
  await page.waitForFunction(() => document.querySelector(".sumline")?.textContent?.includes("2 signs") && !document.querySelector(".banner"), { timeout: 12000 });
  console.log("PASS network failure cleared playback and later request recovered");

  await page.setViewport({ width: 390, height: 844 });
  const width = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.equal(width.content, width.viewport, "mobile viewport must not overflow horizontally");
  await page.screenshot({ path: resolve(shots, "mobile-viewport.png") });
  assert.deepEqual(errors, [], "no uncaught browser errors");
  console.log("PASS 390px viewport and no uncaught browser errors");

  // A blocked request can arrive while an earlier clip is still playing.
  const rapid = await browser.newPage();
  try {
    await rapid.goto(appUrl, { waitUntil: "networkidle2" });
    await rapid.click("#type");
    await rapid.type(input, "Hello, thank you.");
    await rapid.click(".typebox button");
    await rapid.waitForFunction(() => [...document.querySelectorAll("video")].some((v) => !v.paused && v.currentTime > 0.05), { timeout: 12000 });
    await rapid.click(".footrow .textlink");
    await rapid.type(input, "Turn right at the bank.");
    await rapid.click(".typebox button");
    await rapid.waitForSelector(".safety-card", { timeout: 5000 });
    assert.deepEqual(await rapid.evaluate(() => [...document.querySelectorAll("video")].map((v) => [v.getAttribute("src"), v.paused])), [[null, true], [null, true]]);
    await rapid.type(input, "Yes, thank you.");
    await rapid.click(".typebox button");
    await rapid.waitForFunction(() => [...document.querySelectorAll("video")].some((v) => !v.paused && v.currentTime > 0.05), { timeout: 10000 });
    console.log("PASS rapid blocked request stopped active playback; next request resumed");
  } finally {
    await rapid.close();
  }

  const legacy = await browser.newPage();
  const legacyRequest = (request) => {
    if (request.url().endsWith("/api/sign") && request.method() === "POST") {
      void request.respond({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        body: JSON.stringify({ text: "Hello.", words: ["Hello."], playlist: [
          { motion_id: "HELLO", gloss: "HELLO", url: "/clips/HELLO.mp4", duration_s: 1, word_index: 0 }],
          unsupported: [], fingerspell: [], markers: [], plan: null, timings: { translate_ms: 0, total_ms: 0 } }) });
    } else void request.continue();
  };
  try {
    await legacy.setRequestInterception(true);
    legacy.on("request", legacyRequest);
    await legacy.goto(appUrl, { waitUntil: "networkidle2" });
    await legacy.click("#type");
    await legacy.type(input, "Hello.");
    await legacy.click(".typebox button");
    await legacy.waitForFunction(() => document.querySelector(".safety-card")?.textContent?.includes("Update the sign server"), { timeout: 7000 });
    assert.deepEqual(await legacy.evaluate(() => [...document.querySelectorAll("video")].map((v) => v.getAttribute("src"))), [null, null]);
    console.log("PASS legacy response without safety decision failed closed");
  } finally {
    legacy.off("request", legacyRequest);
    await legacy.setRequestInterception(false);
    await legacy.close();
  }
} finally {
  await browser.close();
}
