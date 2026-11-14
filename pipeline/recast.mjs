// Swap the real signer in a video for our avatar, keeping the exact motion.
// Model: minimax/h3-max/recast (fal).
//
// Usage:
//   node recast.mjs --video ../references/how2sign/judy.mp4 \
//                   --avatar ../assets/avatar/avatar-main.jpg \
//                   --out ../out/judy-recast.mp4 [--resolution 768P|1080P] [--seed 123] [--prompt "..."]
//
// Rules learned on 14 Nov 2026:
// - The source video must be 5 to 30 s, with no single shot longer than 15 s.
//   Shorter sign clips must be joined first (or padded with a rest pose).
// - Leave the prompt empty. If you need one, use one plain line,
//   for example "Replace the person with reference 1".
// - Output has the same frame count as the source (timing is 1:1).
// - Recast keeps the source background, the chair, the clothes below the waist
//   and the signer's body build. Pick slim signers for this avatar.
// - It takes about 1.5 to 3 minutes per clip.

import { arg, toUrl, run, download } from "./lib/fal.mjs";

const video = arg("video");
const avatar = arg("avatar");
const out = arg("out");
const resolution = arg("resolution", "768P");
const seed = arg("seed", null);
const prompt = arg("prompt", null);

const input = {
  video_url: await toUrl(video),
  reference_image_urls: [await toUrl(avatar)],
  resolution,
  enable_safety_checker: true,
};
if (seed) input.seed = Number(seed);
if (prompt) input.prompt = prompt;

const { data, requestId, seconds } = await run("minimax/h3-max/recast", input);
await download(data.video.url, out);

// One JSON line per run, so you can paste it into an experiment log.
console.log(JSON.stringify({ model: "minimax/h3-max/recast", video, resolution, seed: data.seed, requestId, seconds, url: data.video.url, out }));
