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

import { readFileSync } from "node:fs";
import { cutClips, joinClips, toId } from "./lib/clips.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) opt[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}

// Sharper hands in fast moves (--every 2): make the batch at --fps 48 (make-batches.mjs or compose.mjs),
// render it at --fps 24 (half speed, real in-between poses), repaint, then cut with --every 2: every 2nd
// frame is kept, so the clip plays at normal speed with half the motion blur per frame.
// Clips from different Recast jobs differ in wall colour and zoom: run pipeline/even-clips.mjs on the
// clip folder before serving it, so a sentence doesn't jump between signs.

if (cmd === "cut") {
  const { video, segments: segPath, "out-dir": outDir } = opt;
  if (!video || !segPath || !outDir) throw new Error("cut needs --video --segments --out-dir [--every 2]");
  const { segments } = JSON.parse(readFileSync(segPath, "utf8"));
  // Neutral segments have gloss null; lib/clips.mjs cuts at the middle of each one (same encoding for every clip).
  await cutClips({ video, segments, outDir, every: Number(opt.every ?? 1), log: (line) => console.log(line) });
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
