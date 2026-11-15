// Drives the test page in one headless Chrome and waits for the session summary.
// Usage: node run.mjs --model lucy-2-6 --clip judy [--loops 2] [--expand 1]
// Needs token-server.mjs running on :8799. Recordings land in ./out/ via the page's /save calls.
import puppeteer from "puppeteer-core";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const params = new URLSearchParams({
  model: arg("model", "lucy-2-6"),
  clip: arg("clip", "judy"),
  loops: arg("loops", "2"),
  warmup: arg("warmup", "2000"),
  tail: arg("tail", "2500"),
  max: arg("max", "30"),
  expand: arg("expand", "1"),
  auto: "1",
});
for (const k of ["prompt", "dry", "rec", "ref", "codec"]) if (arg(k)) params.set(k, arg(k));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    // Hardware path (Intel Xe): GPU canvas + hardware video encode/decode in headless.
    ...(process.env.CHROME_GPU === "0" ? [] : ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-features=PlatformHEVCEncoderSupport"]),
  ],
});
const kill = setTimeout(async () => {
  console.error("driver timeout, closing browser");
  await browser.close().catch(() => {});
  process.exit(2);
}, 90_000);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  // fal websocket URLs carry a short-lived JWT; keep it out of the console.
  const scrub = (s) => s.replace(/fal_jwt_token=[^&\s"]+/g, "fal_jwt_token=[REDACTED]");
  page.on("console", (m) => console.log("page>", scrub(m.text())));
  page.on("pageerror", (e) => console.log("pageerror>", scrub(String(e))));
  await page.goto(`http://127.0.0.1:8799/?${params}`);
  await page.waitForFunction("window.__done", { timeout: 85_000, polling: 500 });
  await page.screenshot({ path: `out/${params.get("dry") ? "dry" : params.get("model")}-${params.get("clip")}${params.get("ref") ? "-ref-" + params.get("ref") : ""}-page.png` });
  await new Promise((r) => setTimeout(r, 1500)); // let the /save uploads finish
} finally {
  clearTimeout(kill);
  await browser.close().catch(() => {});
}
