// Race fal motion-transfer models on the same puppet clip: queue wait vs processing time.
//
//   FAL_KEY=... node pipeline/bench-models.mjs --video PUPPET.mp4 --avatar AVATAR.jpg --out-dir DIR \
//        [--models recast,kling3,kling26,dreamactor,wanturbo] [--split VIDEO_TO_SPLIT_IN_TWO]
//
// All jobs are submitted at once. "queue_s" = submit -> IN_PROGRESS (fal concurrency limit),
// "process_s" = IN_PROGRESS -> COMPLETED (what the model itself costs in time).
// --split cuts a second video in two halves (each padded to Recast's 5 s minimum) and runs
// both halves through Recast in parallel, to measure what parallel chunking buys.
// PAID: every job is a billed fal call.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fal } from "@fal-ai/client";
import { toUrl, download } from "./lib/fal.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const outDir = args["out-dir"];
mkdirSync(outDir, { recursive: true });

const MODELS = {
  recast: { endpoint: "minimax/h3-max/recast", input: (v, a) => ({ video_url: v, reference_image_urls: [a], resolution: "768P", enable_safety_checker: true }) },
  kling3: { endpoint: "fal-ai/kling-video/v3/standard/motion-control", input: (v, a) => ({ video_url: v, image_url: a, character_orientation: "video", keep_original_sound: false }) },
  kling26: { endpoint: "fal-ai/kling-video/v2.6/standard/motion-control", input: (v, a) => ({ video_url: v, image_url: a, character_orientation: "video", keep_original_sound: false }) },
  dreamactor: { endpoint: "fal-ai/bytedance/dreamactor/v2", input: (v, a) => ({ video_url: v, image_url: a, trim_first_second: false }) },
  wanturbo: { endpoint: "fal-ai/wan/v2.2-14b/animate/move", input: (v, a) => ({ video_url: v, image_url: a, resolution: "480p", use_turbo: true }) },
};

const probe = (file) => {
  const out = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,nb_read_frames:format=duration", "-of", "json", file]).toString();
  const j = JSON.parse(out);
  const s = j.streams[0];
  return { width: s.width, height: s.height, fps: s.r_frame_rate, frames: Number(s.nb_read_frames), seconds: Number(Number(j.format.duration).toFixed(3)) };
};

async function job(name, endpoint, input) {
  const t0 = Date.now();
  let tStart = null;
  const { request_id } = await fal.queue.submit(endpoint, { input });
  appendFileSync(join(outDir, "requests.log"), `${new Date().toISOString()} ${name} ${endpoint} ${request_id}
`);
  for (;;) {
    const st = await fal.queue.status(endpoint, { requestId: request_id, logs: false });
    if (st.status === "IN_PROGRESS" && tStart === null) tStart = Date.now();
    if (st.status === "COMPLETED") {
      const tDone = Date.now();
      tStart ??= tDone;
      const res = await fal.queue.result(endpoint, { requestId: request_id });
      const url = res.data?.video?.url;
      const row = { name, endpoint, request_id, queue_s: (tStart - t0) / 1000, process_s: (tDone - tStart) / 1000, total_s: (tDone - t0) / 1000, metrics: st.metrics ?? null };
      if (!url) return { ...row, error: `no video in result: ${JSON.stringify(res.data).slice(0, 200)}` };
      const file = join(outDir, `${name}.mp4`);
      await download(url, file);
      return { ...row, file, output: probe(file) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const [videoUrl, avatarUrl] = await Promise.all([toUrl(args.video), toUrl(args.avatar)]);
const smallAvatar = join(outDir, "avatar-1080.jpg");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", args.avatar, "-vf", "scale=-2:1080", "-q:v", "2", smallAvatar]);
const smallAvatarUrl = await toUrl(smallAvatar);
const input = probe(args.video);
const names = (args.models ?? "recast,kling3,kling26,dreamactor,wanturbo").split(",");
const jobs = names.map((n) => job(n, MODELS[n].endpoint, MODELS[n].input(videoUrl, n === "dreamactor" ? smallAvatarUrl : avatarUrl)).catch((e) => ({ name: n, endpoint: MODELS[n].endpoint, error: String(e?.body?.detail ? JSON.stringify(e.body.detail) : e) })));

let split = null;
if (args.split) {
  const whole = probe(args.split);
  const half = whole.seconds / 2;
  const halves = [0, 1].map((k) => {
    const file = join(outDir, `split-half${k}.mp4`);
    const pad = Math.max(0, 5.05 - half);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(k * half), "-t", String(half), "-i", args.split, "-vf", `tpad=stop_mode=clone:stop_duration=${pad}`, "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", file]);
    return file;
  });
  const urls = await Promise.all(halves.map((f) => toUrl(f)));
  const t0 = Date.now();
  split = Promise.all(urls.map((u, k) => job(`recast-split${k}`, MODELS.recast.endpoint, MODELS.recast.input(u, avatarUrl)).catch((e) => ({ name: `recast-split${k}`, error: String(e?.body?.detail ? JSON.stringify(e.body.detail) : e) })))).then((rows) => ({ whole_seconds: whole.seconds, wall_s: (Date.now() - t0) / 1000, rows }));
}

const results = await Promise.all(jobs);
const splitResult = split ? await split : null;
const report = { input: { file: args.video, ...input }, avatar: args.avatar, results, split: splitResult };
writeFileSync(join(outDir, "bench.json"), JSON.stringify(report, null, 1));
for (const r of results) console.log(r.error ? `${r.name}: ERROR ${r.error}` : `${r.name}: queue ${r.queue_s.toFixed(0)}s, process ${r.process_s.toFixed(0)}s, out ${r.output.frames}f ${r.output.width}x${r.output.height} @${r.output.fps}`);
if (splitResult) console.log(`recast split in 2 (parallel): wall ${splitResult.wall_s.toFixed(0)}s for ${splitResult.whole_seconds}s of video; ` + splitResult.rows.map((r) => r.error ? `${r.name} ERROR ${r.error}` : `${r.name} queue ${r.queue_s.toFixed(0)}s process ${r.process_s.toFixed(0)}s`).join(", "));
