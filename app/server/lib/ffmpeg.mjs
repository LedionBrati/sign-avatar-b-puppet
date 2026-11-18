// ffmpeg / ffprobe on PATH? /api/sign.mp4 joins clips with ffmpeg (pipeline/lib/clips.mjs joinClips) and generate-on-use
// cuts and probes with both. Checked once per process, so a missing binary is a clear error, not a spawn ENOENT.

import { spawnSync } from "node:child_process";

const seen = new Map();

/** True if `bin -version` runs. */
export function hasTool(bin) {
  if (!seen.has(bin)) {
    const r = spawnSync(bin, ["-version"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    seen.set(bin, !r.error && r.status === 0);
  }
  return seen.get(bin);
}

export const NO_FFMPEG = "ffmpeg is not on PATH (install it: winget install ffmpeg / brew install ffmpeg / apt install ffmpeg)";
