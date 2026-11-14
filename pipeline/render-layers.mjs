// Render the caption, labels and credit as PNG layers with headless Chrome.
// Why Chrome: our ffmpeg build has no text filter (no drawtext), and Chrome
// gives real fonts, auto line-wrapping and transparent PNGs.
//
// Usage:
//   node render-layers.mjs --text "Hi, I'm Judy..." --out-dir ../out/judy-layers \
//        [--credit "Signer clip: ..."] [--left "Real ASL signer"] [--right "AI avatar"]
//
// Writes:
//   land.png   1920x1080 background for the side-by-side video (labels, caption, credit)
//   vbg.png    1080x1920 background for the phone video (caption, credit)
//   vtopA.png  1080x1920 transparent: "AI avatar" chip + white frame for the small window
//   vtopB.png  1080x1920 transparent: "Real signer" chip on top of the small window
//
// Chrome path: set CHROME=/path/to/chrome if it is not the default macOS one.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    if (fallback === undefined) { console.error(`Missing --${name}`); process.exit(1); }
    return fallback;
  }
  return process.argv[i + 1];
}

const text = arg("text");
const outDir = resolve(arg("out-dir"));
const credit = arg("credit", "Signer clip: How2Sign (Duarte et al., CVPR 2021), CC BY-NC 4.0. Avatar is AI-generated with fal H3 Max Recast. Background changed.");
const left = arg("left", "Real ASL signer");
const right = arg("right", "AI avatar");
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(outDir, { recursive: true });
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "’");
const quoted = `“${esc(text)}”`;

// Design tokens. Text ramp: primary #F2F2F2 (caption), secondary #B8BCC6 (labels),
// meta #8A8F99 (credit, about 6:1 on the background). Font: Avenir Next (macOS).
const base = `*{margin:0;padding:0;box-sizing:border-box}html,body{background:transparent}
body{font-family:"Avenir Next","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased;position:relative}
.chip{position:absolute;font-weight:600;color:#fff;background:rgba(0,0,0,.6);border-radius:999px}`;

const pages = {
  land: [1920, 1080, `body{width:1920px;height:1080px;background:#0E0F12}
.lab{position:absolute;top:30px;font-weight:600;font-size:26px;color:#B8BCC6}
.cap{position:absolute;top:910px;left:310px;width:1300px;text-align:center;font-weight:600;font-size:33px;line-height:46px;color:#F2F2F2}
.cred{position:absolute;top:1030px;left:0;width:1920px;text-align:center;font-weight:500;font-size:17px;color:#8A8F99}`,
    `<div class="lab" style="left:330px">${esc(left)}</div><div class="lab" style="left:975px">${esc(right)}</div>
<div class="cap">${quoted}</div><div class="cred">${esc(credit)}</div>`],
  vbg: [1080, 1920, `body{width:1080px;height:1920px;background:#0E0F12}
.cap{position:absolute;top:1500px;left:60px;width:960px;text-align:center;font-weight:600;font-size:42px;line-height:60px;color:#F2F2F2}
.cred{position:absolute;top:1810px;left:90px;width:900px;text-align:center;font-weight:500;font-size:22px;line-height:34px;color:#8A8F99}`,
    `<div class="cap">${quoted}</div><div class="cred">${esc(credit)}</div>`],
  vtopA: [1080, 1920, `body{width:1080px;height:1920px}`,
    `<div class="chip" style="left:32px;top:32px;font-size:26px;padding:10px 24px">${esc(right)}</div>
<div style="position:absolute;left:745px;top:29px;width:306px;height:406px;border-radius:12px;background:rgba(255,255,255,.85)"></div>`],
  vtopB: [1080, 1920, `body{width:1080px;height:1920px}`,
    `<div class="chip" style="left:760px;top:374px;font-size:21px;padding:8px 18px">Real signer</div>`],
};

const work = mkdtempSync(join(tmpdir(), "layers-"));
for (const [name, [w, h, css, html]] of Object.entries(pages)) {
  const file = join(work, `${name}.html`);
  writeFileSync(file, `<html><head><meta charset="utf-8"><style>${base}${css}</style></head><body>${html}</body></html>`);
  execFileSync(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    `--user-data-dir=${join(work, "profile")}`, "--force-device-scale-factor=1",
    "--default-background-color=00000000", `--window-size=${w},${h}`,
    `--screenshot=${join(outDir, `${name}.png`)}`, `file://${file}`,
  ], { stdio: "ignore" });
  console.log(`wrote ${join(outDir, `${name}.png`)}`);
}
