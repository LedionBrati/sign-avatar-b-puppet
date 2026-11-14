import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS, planModel } from "./models.mjs";
import { makeComparison, probeVideo } from "./video.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dateId = () => new Date().toISOString().replace(/[:.]/g, "-");

export function parseOptions(argv) {
  const options = {};
  const values = new Set(["puppet", "source", "avatar", "generated", "model", "resolution", "run-dir", "max-usd", "authorize-paid"]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--execute" || flag === "--dry-run") { options[flag.slice(2)] = true; continue; }
    if (!flag.startsWith("--") || !values.has(flag.slice(2)) || i === argv.length - 1 || argv[i + 1].startsWith("--")) {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
    options[flag.slice(2)] = argv[++i];
  }
  if (options.execute && options["dry-run"]) throw new Error("Choose either --execute or --dry-run");
  if (!options.puppet) throw new Error("--puppet MP4 is required");
  options.model ??= "all";
  options.resolution ??= "768P";
  options.avatar ??= join(repoRoot, "assets/avatar/avatar-main.jpg");
  options["run-dir"] ??= join(repoRoot, "experiments/e0/runs", dateId());
  return options;
}

export function guardPaid(options, plan) {
  if (!options.execute) return;
  if (options.model === "all") throw new Error("Paid execution requires one --model per run");
  if (options["authorize-paid"] !== "E0-PAID") throw new Error("Paid execution requires --authorize-paid E0-PAID");
  const maxUsd = Number(options["max-usd"]);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 30) throw new Error("--max-usd must be >0 and <=30 for paid execution");
  if (!plan.executable || plan.estimated_max_usd == null) throw new Error(`${plan.name} paid execution is disabled until pricing is bounded`);
  if (!plan.eligible) throw new Error(`${plan.name} video is outside endpoint duration limits`);
  if (plan.estimated_max_usd > maxUsd) throw new Error(`Estimated reserve $${plan.estimated_max_usd} exceeds --max-usd $${maxUsd}`);
  if (!options.source) throw new Error("Paid execution requires --source for comparison");
  if (options.generated) throw new Error("Do not combine --generated with --execute");
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY is required for paid execution");
}

const checkAvatar = async (path) => {
  if (![".jpg", ".jpeg", ".png"].includes(extname(path).toLowerCase())) throw new Error("--avatar must be JPG or PNG");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) throw new Error("Avatar image is empty or not a file");
};

function reportMarkdown(report) {
  const modelRows = report.models.map((m) => `| ${m.name} | ${m.endpoint} | ${m.eligible ? "yes" : "no"} | ${m.estimated_max_usd == null ? "unknown" : `$${m.estimated_max_usd.toFixed(2)}`} | ${m.executable ? "schema + price reserve" : "dry-run only"} |`).join("\n");
  const files = report.comparison?.path ? `\nComparison: \`${report.comparison.path}\` (left: signer; middle: puppet; right: generated)\n` : "\nComparison awaits a generated video and source clip.\n";
  return `# E0 repaint experiment — ${report.run_id}\n\nStatus: **${report.status}** · Mode: **${report.mode}** · Created: ${report.created_at}\n\n` +
    `## Inputs\n\n- Original signer: ${report.inputs.source?.path ?? "not supplied"}\n- Puppet: ${report.inputs.puppet.path}\n- Avatar image: ${report.inputs.avatar}\n- Generated: ${report.inputs.generated?.path ?? "not supplied"}\n\n` +
    `Puppet metadata: ${report.inputs.puppet.width}×${report.inputs.puppet.height}, ${report.inputs.puppet.fps} fps, ${report.inputs.puppet.frame_count} frames, ${report.inputs.puppet.duration_seconds}s, aspect ${report.inputs.puppet.aspect_ratio}.\n\n` +
    `Alignment: ${report.alignment.map((a) => `${a.pair} Δduration=${a.duration_delta_seconds}s, Δframes=${a.frame_delta}, Δfps=${a.fps_delta}${a.warning ? " (review required)" : ""}`).join("; ") || "pending other videos"}.\n\n` +
    `## Model preparation\n\n| Model | Endpoint | Duration eligible | Conservative reserve | Execution |\n|---|---|---|---|---|\n${modelRows}\n\n` +
    `Paid request ID: ${report.paid?.request_id ?? "none"}. Estimated reserve: ${report.paid?.estimated_max_usd == null ? "n/a" : `$${report.paid.estimated_max_usd.toFixed(2)}`}. Output cost estimate: ${report.paid?.estimated_output_cost_usd == null ? "n/a" : `$${report.paid.estimated_output_cost_usd.toFixed(2)}`}. Actual billed cost: ${report.paid?.actual_cost_usd ?? "not available from this API response; check fal billing"}. Runtime: ${report.paid?.runtime_seconds == null ? "n/a" : `${report.paid.runtime_seconds}s`}.\n` + files +
    `\n## Manual ASL evaluation (fluent signer required)\n\n` +
    `Compare the same timestamps in original, puppet and repaint. Record frame numbers and whether the tracking, puppet or repaint caused each difference.\n\n` +
    `- [ ] Thumb position and individual finger curl/spread match the source.\n- [ ] Handshape is recognizable in every held sign and transition.\n- [ ] Palm direction and wrist angle match the source.\n- [ ] Hand location and contact with body/face are preserved.\n- [ ] Facial grammar (eyebrows, mouth, head movement) is preserved or clearly marked missing.\n- [ ] Timing, handedness and motion direction stay consistent; no added or dropped signs.\n- [ ] A fluent or Deaf ASL reviewer records a judgment and specific failures.\n\n` +
    `Reviewer: _pending_ · Judgment: **not evaluated** · Go/no-go: **pending**.\n\n` +
    `## Notes\n\n${report.notes.map((n) => `- ${n}`).join("\n")}\n`;
}

async function saveReport(runDir, report) {
  await writeFile(join(runDir, "result.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(runDir, "report.md"), reportMarkdown(report));
}

function alignment(inputs) {
  const pairs = [["source–puppet", inputs.source, inputs.puppet], ["puppet–generated", inputs.puppet, inputs.generated]];
  return pairs.filter(([,a,b]) => a && b).map(([pair,a,b]) => {
    const duration_delta_seconds = Number(Math.abs(a.duration_seconds - b.duration_seconds).toFixed(3));
    const frame_delta = Math.abs(a.frame_count - b.frame_count);
    const fps_delta = Number(Math.abs(a.fps - b.fps).toFixed(4));
    return { pair, duration_delta_seconds, frame_delta, fps_delta,
      warning: duration_delta_seconds > 0.1 || frame_delta > 1 || fps_delta > 0.01 };
  });
}

export async function runExperiment(options) {
  const puppet = await probeVideo(options.puppet);
  const source = options.source ? await probeVideo(options.source) : null;
  const generated = options.generated ? await probeVideo(options.generated) : null;
  const avatar = resolve(options.avatar);
  await checkAvatar(avatar);
  const selected = options.model === "all" ? Object.keys(MODELS) : [options.model];
  const models = selected.map((name) => planModel(name, puppet, options.resolution));
  if (options.execute) guardPaid(options, models[0]);
  const runDir = resolve(options["run-dir"]);
  await mkdir(runDir, { recursive: true });
  try { await stat(join(runDir, "result.json")); throw new Error(`Run report already exists: ${runDir}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const report = {
    schema_version: 1, run_id: basename(runDir), created_at: new Date().toISOString(),
    status: "prepared", mode: options.execute ? "paid" : "dry-run", inputs: { puppet, source, avatar, generated },
    models, paid: null, comparison: null, alignment: alignment({ source, puppet, generated }),
    notes: ["No ASL accuracy claim is made by this harness.",
      "Cost reserves are conservative estimates, not a guaranteed fal account spending cap; verify current price before paid execution.",
      "The original signer and puppet must be aligned to the same signing segment before visual scoring."],
  };
  if (source && source.path === puppet.path) report.notes.push("Source and puppet are the same file; this run is a wiring test, not an E0 evaluation.");
  if (puppet.aspect_ratio !== "3:4") report.notes.push(`Puppet aspect ${puppet.aspect_ratio} differs from the team's 3:4 avatar framing.`);
  await saveReport(runDir, report);
  if (options.execute) {
    const model = MODELS[options.model];
    const started = Date.now();
    report.status = "running";
    report.paid = { model: options.model, estimated_max_usd: models[0].estimated_max_usd,
      max_usd: Number(options["max-usd"]), actual_cost_usd: null, estimated_output_cost_usd: null,
      request_id: null, runtime_seconds: null };
    await saveReport(runDir, report);
    try {
      // Import only inside the explicitly authorized paid path. toUrl uploads local files.
      const { toUrl, run, download } = await import("../lib/fal.mjs");
      const videoUrl = await toUrl(puppet.path), avatarUrl = await toUrl(avatar);
      const input = model.input({ videoUrl, avatarUrl, resolution: options.resolution });
      const result = await run(model.endpoint, input);
      report.paid.request_id = result.requestId;
      report.paid.runtime_seconds = result.seconds;
      const outputUrl = result.data?.video?.url;
      if (!outputUrl) throw new Error("Model returned no video URL");
      const output = join(runDir, "generated.mp4");
      await download(outputUrl, output);
      report.inputs.generated = await probeVideo(output);
      report.paid.estimated_output_cost_usd = model.estimate(report.inputs.generated.duration_seconds, options.resolution);
      report.alignment = alignment(report.inputs);
      report.status = "generated_unreviewed";
      report.paid.seed = result.data.seed ?? null;
    } catch (error) {
      report.status = "failed";
      report.notes.push(`Paid path failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      report.paid.runtime_seconds ??= Number(((Date.now() - started) / 1000).toFixed(2));
      await saveReport(runDir, report);
    }
  }
  if (source && report.inputs.generated) {
    const output = join(runDir, "comparison.mp4");
    await makeComparison(source.path, puppet.path, report.inputs.generated.path, output);
    report.comparison = { path: output, panels: ["original signer", "puppet", "generated realistic avatar"],
      metadata: await probeVideo(output) };
    if (!options.execute) report.status = "comparison_unreviewed";
    await saveReport(runDir, report);
  }
  return { runDir, report };
}
