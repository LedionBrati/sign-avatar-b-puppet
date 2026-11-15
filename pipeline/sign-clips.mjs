// Real-time realistic signing: pre-rendered avatar clips per sign, joined at runtime.
//
// Offline, once per batch of signs:
//   1. puppet/compose.mjs joins  NEUTRAL, SIGN, NEUTRAL, SIGN, ..., NEUTRAL  into one motion
//   2. puppet/render.mjs renders it, H3 Max Recast repaints it (timing stays frame-exact)
//   3. this script CUTS the repainted video at the middle of every neutral pause,
//      so each sign clip starts and ends in the same neutral pose:
//        node pipeline/sign-clips.mjs cut --video generated.mp4 --segments batch-a.json --out-dir out/realtime/clips
//
// At runtime, per sentence (no fal call, no rendering):
//        node pipeline/sign-clips.mjs say --clips out/realtime/clips --out sentence.mp4 THANK_YOU SEE YOU LATER
//   joins the clips with stream copy (no re-encode) and prints how long it took.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ffmpeg, joinClips, toId } from "./lib/clips.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) opt[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}

// Every clip gets the same encoding so `say` can join them without re-encoding.
const ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "24", "-g", "12", "-movflags", "+faststart"];

if (cmd === "cut") {
  const { video, segments: segPath, "out-dir": outDir } = opt;
  if (!video || !segPath || !outDir) throw new Error("cut needs --video --segments --out-dir");
  const { segments } = JSON.parse(readFileSync(segPath, "utf8"));
  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  // Neutral segments have gloss null; cut at the middle of each one.
  const mids = segments.filter((s) => !s.gloss).map((s) => Math.floor((s.start + s.end) / 2));
  const signs = segments.filter((s) => s.gloss);
  if (mids.length !== signs.length + 1) throw new Error("expected NEUTRAL around every sign");
  signs.forEach((s, k) => {
    const id = toId(s.gloss);
    const [a, b] = [mids[k], mids[k + 1]];
    const file = `${id}.mp4`;
    ffmpeg(["-i", video, "-vf", `trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS`, ...ENCODE, join(outDir, file)]);
    manifest[id] = { gloss: s.gloss, file, frames: b - a, seconds: Number(((b - a) / 24).toFixed(3)), source_video: resolve(video), source_frames: [a, b] };
    console.log(`${id}: frames ${a}-${b} (${b - a})`);
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
} else if (cmd === "say") {
  const { clips, out } = opt;
  if (!clips || !out || positional.length === 0) throw new Error("say needs --clips --out and glosses");
  const result = joinClips({ clipsDir: clips, ids: positional.map(toId), out });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
} else {
  console.error("usage: sign-clips.mjs cut --video V --segments S --out-dir D | say --clips D --out O GLOSS...");
  process.exit(2);
}
