#!/usr/bin/env node
// Model race: run every candidate on the same reference, then score fingers on each output.
//
// Dry run (default; no key, no upload, no spend). Prints the exact plan and cost:
//   node pipeline/race.mjs --ref out/race/demo3/demo3-vrm.mp4 --pose out/race/demo3/demo3-pose.mp4 \
//        [--depth DEPTH.mp4] [--normal NORMAL.mp4] [--models recast,kling3pro,...] [--run-dir DIR]
//
// Score outputs you already have (free), e.g. the 15 Nov race on judy-vrm.mp4:
//   node pipeline/race.mjs --ref out/puppet/judy-vrm.mp4 --existing recast=A.mp4,kling3=B.mp4,dreamactor=C.mp4
//
// Paid (never by default): one billed fal call per model, all submitted at once.
//   FAL_KEY=... node pipeline/race.mjs ... --execute --authorize-paid RACE-PAID --max-usd 12
//
// Next to --ref the race looks for <name>.json (sign segments) and <name>.clean.json (the motion), as
// written by pipeline/race-prep.mjs, so scoring covers sign frames and also compares against the source hands.
// Writes <run-dir>/race.json, race.md, requests.log, <model>.mp4, finger/<model>-{finger.json,worst.png}.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { RACE_MODELS, planRace } from "./race/models.mjs";
import { repoRoot, scorePair, sidecars } from "./lib/finger.mjs";

const DEFAULT_MODELS = "recast,h3_3d,kling3pro,dreamactor,ltx_r2r,vace_pose,vace_depth,scail2";
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const flag = (name) => argv.includes(`--${name}`);

if (flag("help") || !opt("ref")) {
  console.log(`usage: node pipeline/race.mjs --ref RGB.mp4 [--pose P.mp4] [--depth D.mp4] [--normal N.mp4]
  [--models ${DEFAULT_MODELS}] [--avatar IMG] [--first-frame IMG] [--run-dir DIR]
  [--segments S.json] [--motion M.clean.json] [--recognizer URL] [--existing model=file.mp4,...] [--max-shift N]
  [--execute --authorize-paid RACE-PAID --max-usd N]     (paid; never the default)`);
  process.exit(flag("help") ? 0 : 2);
}

function probe(file) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,r_frame_rate,nb_read_frames:format=duration", "-of", "json", file]).toString());
  const s = j.streams[0], [n, d = 1] = s.r_frame_rate.split("/").map(Number);
  return { file, width: s.width, height: s.height, fps: n / d, frames: Number(s.nb_read_frames), seconds: Number(Number(j.format.duration).toFixed(3)) };
}

const ref = probe(resolve(opt("ref")));
const videos = { rgb: ref.file };
for (const k of ["pose", "depth", "normal"]) {
  if (!opt(k)) continue;
  const v = probe(resolve(opt(k)));
  if (Math.abs(v.frames - ref.frames) > 1) throw new Error(`--${k} has ${v.frames} frames, the reference has ${ref.frames}; they must be frame-aligned`);
  videos[k] = v.file;
}
const avatar = resolve(opt("avatar", join(repoRoot, "assets/avatar/avatar-main.jpg")));
const found = sidecars(ref.file);
const segments = opt("segments", found.segments), motion = opt("motion", found.motion);
const existing = Object.fromEntries((opt("existing", "") || "").split(",").filter(Boolean).map((kv) => kv.split("=")).map(([k, v]) => [k, resolve(v)]));
const names = (opt("models") ?? (Object.keys(existing).length ? "" : DEFAULT_MODELS)).split(",").filter(Boolean);
const runDir = resolve(opt("run-dir", join(repoRoot, "out/race/runs", `${basename(ref.file, ".mp4")}-${new Date().toISOString().replace(/[:.]/g, "-")}`)));
mkdirSync(runDir, { recursive: true });

// 1. Plan and price.
const plans = names.map((n) => planRace(n, ref, videos));
const eligible = plans.filter((p) => p.eligible);
const total = Number(eligible.reduce((s, p) => s + p.cost_usd, 0).toFixed(3));
console.log(`reference ${ref.file}: ${ref.frames} frames, ${ref.seconds}s, ${ref.width}x${ref.height} @${ref.fps.toFixed(2)}; ` +
  `conditioning: ${Object.keys(videos).join(", ")}; segments: ${segments ? "yes" : "no"}; motion: ${motion ? "yes" : "no"}`);
console.table(plans.map((p) => ({ model: p.name, endpoint: p.endpoint, needs: p.needs.join("+"), billed_s: p.billed_seconds,
  usd: p.cost_usd, price: p.exact ? "exact" : "reserve", schema: p.verified ? "checked" : "UNVERIFIED", run: p.eligible ? "yes" : p.problems.join("; ") })));
console.log(`total for ${eligible.length} eligible models: $${total.toFixed(2)}${eligible.some((p) => !p.exact) ? " (includes reserves; see price column)" : ""}`);

const report = { schema_version: 1, created_at: new Date().toISOString(), mode: flag("execute") ? "paid" : "dry-run",
  reference: ref, conditioning: videos, avatar, segments, motion, plans, total_usd: total, outputs: {}, scores: [] };
const save = () => { writeFileSync(join(runDir, "race.json"), JSON.stringify(report, null, 1) + "\n"); writeFileSync(join(runDir, "race.md"), markdown(report)); };
save();

// 2. Paid path: explicit authorization, a budget that covers the whole plan, and verified schemas only.
if (flag("execute")) {
  if (opt("authorize-paid") !== "RACE-PAID") throw new Error("Paid race requires --authorize-paid RACE-PAID");
  const maxUsd = Number(opt("max-usd"));
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 50) throw new Error("--max-usd must be >0 and <=50");
  if (total > maxUsd) throw new Error(`Planned $${total} exceeds --max-usd $${maxUsd}`);
  const unverified = eligible.filter((p) => !p.verified).map((p) => p.name);
  if (unverified.length) throw new Error(`Drop models with unverified schemas first: ${unverified.join(", ")}`);
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY is required for paid execution");
  const { fal } = await import("@fal-ai/client");
  const { toUrl, download } = await import("./lib/fal.mjs");
  const padded = (file, plan) => {
    if (!plan.pad_to_seconds) return file;
    const out = join(runDir, `${basename(file, ".mp4")}-pad${plan.pad_to_seconds}s.mp4`);
    if (!existsSync(out)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `tpad=stop_mode=clone:stop_duration=${(plan.pad_to_seconds - ref.seconds).toFixed(3)}`,
      "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out]);
    return out;
  };
  const small = join(runDir, "avatar-1080.jpg");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", avatar, "-vf", "scale=-2:'min(1080,ih)'", "-q:v", "2", small]);
  const urls = { avatar: await toUrl(avatar), avatarSmall: await toUrl(small), firstFrame: opt("first-frame") ? await toUrl(resolve(opt("first-frame"))) : null };
  await Promise.all(eligible.map(async (plan) => {
    const m = RACE_MODELS[plan.name], t0 = Date.now();
    try {
      const inputs = { ...urls };
      for (const k of plan.needs) inputs[k] = await toUrl(padded(videos[k], plan));
      const { request_id } = await fal.queue.submit(m.endpoint, { input: m.input(inputs, ref) });
      appendFileSync(join(runDir, "requests.log"), `${new Date().toISOString()} ${plan.name} ${m.endpoint} ${request_id}\n`);
      report.outputs[plan.name] = { request_id, status: "submitted" }; save();
      for (;;) {
        const st = await fal.queue.status(m.endpoint, { requestId: request_id, logs: false });
        if (st.status === "COMPLETED") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const res = await fal.queue.result(m.endpoint, { requestId: request_id });
      const url = res.data?.video?.url;
      if (!url) throw new Error(`no video in result: ${JSON.stringify(res.data).slice(0, 200)}`);
      const file = join(runDir, `${plan.name}.mp4`);
      await download(url, file);
      report.outputs[plan.name] = { request_id, status: "done", file, seconds: (Date.now() - t0) / 1000, output: probe(file) };
    } catch (e) {
      report.outputs[plan.name] = { ...(report.outputs[plan.name] ?? {}), status: "failed", error: String(e?.body?.detail ? JSON.stringify(e.body.detail) : e) };
    }
    save();
  }));
}

// 3. Score every output we have (just generated, or passed with --existing). Free.
for (const [name, file] of Object.entries(existing)) report.outputs[name] = { status: "existing", file, output: probe(file) };
const recognizer = opt("recognizer", "http://127.0.0.1:8788");
for (const [name, o] of Object.entries(report.outputs)) {
  if (!o.file) continue;
  const shift = Number(opt("max-shift", RACE_MODELS[name]?.shift ?? 0));
  try {
    const row = await scorePair({ ref: ref.file, gen: o.file, out: join(runDir, "finger"), name, segments, motion, recognizer, maxShift: shift });
    report.scores.push({ model: name, ...row });
  } catch (e) {
    report.scores.push({ model: name, error: String(e) });
  }
  save();
}
if (report.scores.length) {
  // Rank by handshape changes against the source hands when we have the motion (else against the reference
  // video), then by joint error. A changed handshape is a wrong sign; a few degrees of bend usually is not.
  const key = (s) => [s.total_shape_change ?? s.shape_change ?? 999, s.total_err ?? s.joint_err ?? 999];
  report.scores.sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
  save();
  console.table(report.scores.map((s) => ({ model: s.model, shape_vs_motion_pct: s.total_shape_change, deg_vs_motion: s.total_err,
    shape_vs_ref_pct: s.shape_change, deg_vs_ref: s.joint_err, drop_pct: s.total_drop ?? s.drop, shift: s.shift, index_flip_pct: s.index_flip, rec_gen_top1: s.rec_gen_top1, worst_png: s.worst_png && basename(s.worst_png) })));
}
console.log(`report: ${join(runDir, "race.md")}`);

function markdown(r) {
  const rows = r.plans.map((p) => `| ${p.name} | \`${p.endpoint}\` | ${p.needs.join(" + ")} | ${p.billed_seconds} | $${p.cost_usd.toFixed(3)} | ${p.exact ? "exact" : "reserve"} | ${p.verified ? "checked" : "unverified"} | ${p.eligible ? "yes" : p.problems.join("; ")} |`).join("\n");
  const scores = r.scores.map((s) => s.error ? `| ${s.model} | error: ${s.error} |||||||||` :
    `| ${s.model} | ${s.total_shape_change ?? "-"} | ${s.total_err ?? "-"} | ${s.shape_change ?? "-"} | ${s.joint_err ?? "-"} | ${s.total_drop ?? s.drop ?? "-"} | ${s.index_flip ?? "-"} | ${s.rec_gen_top1 ?? "-"} | ${s.shift ?? 0} | ${s.worst_png ? `finger/${basename(s.worst_png)}` : "-"} |`).join("\n");
  return `# Model race on ${basename(r.reference.file)}\n\nMode: **${r.mode}** · ${r.created_at}\n\n` +
    `Reference: ${r.reference.frames} frames, ${r.reference.seconds}s, ${r.reference.width}x${r.reference.height}. Conditioning: ${Object.keys(r.conditioning).join(", ")}.\n\n` +
    `| Model | Endpoint | Needs | Billed s | Cost | Price | Schema | Runs |\n|---|---|---|---|---|---|---|---|\n${rows}\n\n**Total: $${r.total_usd.toFixed(2)}**\n\n` +
    (r.scores.length ? `## Finger scores (lower is better, best first)\n\n| Model | Handshape changed vs source hands (%) | Joint err vs source hands (deg) | Handshape changed vs reference video (%) | Joint err vs reference video (deg) | Hand lost (%) | Index flipped (%) | Recognizer top-1 (%) | Offset (frames) | Worst frames |\n|---|---|---|---|---|---|---|---|---|---|\n${scores}\n` : "") +
    `\nRequest IDs: ${Object.entries(r.outputs).map(([k, o]) => `${k} ${o.request_id ?? o.status}`).join(", ") || "none"}.\n`;
}
