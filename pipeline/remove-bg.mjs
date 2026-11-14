// Cut the person out of a video. Gives two files: color.mp4 and alpha.mp4 (the mask).
// Model: veed/video-background-removal (fal), output_codec h264.
// On 14 Nov 2026 this gave cleaner hands than bria/video/background-removal/v3.
//
// Usage:
//   node remove-bg.mjs --video ../out/judy-recast.mp4 --out-dir ../out/judy-matte
//
// Then put the person on the wall with composite.sh.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { arg, toUrl, run, download } from "./lib/fal.mjs";

const video = arg("video");
const outDir = arg("out-dir");
await mkdir(outDir, { recursive: true });

const { data, requestId, seconds } = await run("veed/video-background-removal", {
  video_url: await toUrl(video),
  output_codec: "h264",
  refine_foreground_edges: true,
  subject_is_person: true,
});

// The result is a list: one file named color.mp4, one named alpha.mp4.
const files = Array.isArray(data.video) ? data.video : [data.video];
const color = files.find((f) => /color/i.test(f.file_name || f.url)) || files[0];
const alpha = files.find((f) => /alpha/i.test(f.file_name || f.url)) || files[1];
await download(color.url, join(outDir, "color.mp4"));
await download(alpha.url, join(outDir, "alpha.mp4"));

console.log(JSON.stringify({ model: "veed/video-background-removal", video, requestId, seconds, outDir }));
