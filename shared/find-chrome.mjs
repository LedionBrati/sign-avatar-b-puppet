// Chrome / Chromium executable for the scripts that drive a headless browser (puppeteer-core renders, screenshots,
// smoke tests). $CHROME wins; otherwise the standard install locations for this platform. One clear error when none
// is there, instead of each script guessing a single path.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Install locations checked when CHROME is not set, for this platform. */
export function chromeCandidates({ env = process.env, platform = process.platform } = {}) {
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES || "C:/Program Files", env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)", env.LOCALAPPDATA].filter(Boolean);
    return roots.map((r) => join(r, "Google/Chrome/Application/chrome.exe").replace(/\\/g, "/"));
  }
  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
}

/** Path to Chrome: $CHROME, else the first standard location that exists. Throws with what to do when there is none. */
export function findChrome({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (env.CHROME) return env.CHROME;
  const candidates = chromeCandidates({ env, platform });
  const hit = candidates.find((p) => exists(p));
  if (!hit) throw new Error(`Chrome not found (looked in: ${candidates.join(", ")}); install Google Chrome or set CHROME=/path/to/chrome`);
  return hit;
}
