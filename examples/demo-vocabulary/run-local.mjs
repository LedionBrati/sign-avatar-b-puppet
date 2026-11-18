// Local, rights-gated demo assembly. Never downloads or commits WLASL media.
// From repository root: node examples/demo-vocabulary/run-local.mjs [--force] [--no-render]
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlayback } from "../../shared/contracts.mjs";
import { assertMotionV1 } from "../../shared/motion-format.mjs";
import { auditVerifiedCatalog, createMotionLoader } from "../../shared/motion-loader.node.mjs";
import { ffmpegPath, ffprobePath } from "../../shared/ffmpeg.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(join(root, "examples/demo-vocabulary/manifest.json"), "utf8"));
const args = process.argv.slice(2);
const force = args.includes("--force");
const render = !args.includes("--no-render");
if (args.some((arg) => !["--force", "--no-render"].includes(arg))) {
  console.error("Usage: node examples/demo-vocabulary/run-local.mjs [--force] [--no-render]");
  process.exit(2);
}

function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}

// The children (motion/report.py, puppet/render.mjs) read FFMPEG / FFPROBE; the bundled pipeline/ binaries first.
function ffmpegEnv() {
  return { ...process.env, FFMPEG: ffmpegPath({ prefer: "bundled" }), FFPROBE: ffprobePath({ prefer: "bundled" }) };
}

async function puppetFunctions() {
  const puppetRequire = createRequire(pathToFileURL(join(root, "puppet/package.json")));
  const { transformWithOxc } = await import(pathToFileURL(puppetRequire.resolve("vite")));
  async function fromTs(name) {
    const source = readFileSync(join(root, `puppet/src/${name}.ts`), "utf8");
    const { code } = await transformWithOxc(source, `${name}.ts`, { lang: "ts" });
    return import(`data:text/javascript,${encodeURIComponent(code)}`);
  }
  return fromTs("motion");
}

const stats = (motion) => ({
  fps: motion.fps, frames: motion.frames.length, dominant_hand: motion.dominant_hand,
  mirrored: motion.mirrored, trim: motion.cleanup?.trim,
  pose_frames: motion.frames.filter((f) => f.pose).length,
  face_frames: motion.frames.filter((f) => f.face).length,
  left_hand_frames: motion.frames.filter((f) => f.leftHand).length,
  right_hand_frames: motion.frames.filter((f) => f.rightHand).length,
  filled_frames: motion.cleanup?.filled_frames ?? {},
});

try {
  const env = ffmpegEnv();
  const { validateMotion } = await puppetFunctions();
  const localCatalog = {
    schema_version: 1,
    test_only: true,
    note: "Local technical wiring fixture. Status is required by loadPlayback; no signer or rights QA is asserted.",
    signs: manifest.signs.map((sign) => ({ id: sign.id, gloss: sign.gloss,
      status: "verified", motion_path: sign.clean_path,
      source: `WLASL v0.3 video ${sign.wlasl_video_id}, ${sign.source}, signer ${sign.signer}`,
      license: manifest.rights })),
    fingerspelling: {},
  };
  const summary = { purpose: manifest.purpose, signs: {}, sequences: {} };

  for (const sign of manifest.signs) {
    const source = join(root, sign.source_path);
    const rawPath = join(root, sign.raw_path);
    const cleanPath = join(root, sign.clean_path);
    const reportDir = join(root, sign.report_dir);
    if (!existsSync(source)) throw new Error(`Missing local source: ${sign.source_path}. See README.md; this script never downloads WLASL media.`);
    mkdirSync(dirname(rawPath), { recursive: true });
    if (force || !existsSync(rawPath)) run(process.env.UV_BIN ?? "uv", ["run", "python", "extract.py", source,
      "--out", rawPath, "--name", sign.stem, "--dataset", "WLASL", "--license", manifest.rights,
      "--signer", sign.signer, "--gloss", sign.gloss, "--motion-id", sign.id,
      "--source-file", sign.source_path], join(root, "motion"), env);
    if (force || !existsSync(cleanPath)) run(process.env.UV_BIN ?? "uv", ["run", "python", "clean.py", rawPath,
      "--out", cleanPath, "--trim-rest"], join(root, "motion"), env);
    if (force || !existsSync(reportDir)) run(process.env.UV_BIN ?? "uv", ["run", "python", "report.py", rawPath,
      cleanPath, "--video", source, "--out-dir", reportDir], join(root, "motion"), env);

    const raw = JSON.parse(readFileSync(rawPath, "utf8"));
    const clean = JSON.parse(readFileSync(cleanPath, "utf8"));
    assertMotionV1(raw, { expectedMotionId: sign.id, fileStem: sign.stem });
    assertMotionV1(clean, { expectedMotionId: sign.id, requireClean: true, fileStem: sign.stem });
    if (raw.gloss !== sign.gloss || clean.gloss !== sign.gloss) throw new Error(`${sign.id}: gloss mismatch`);
    const rawWarnings = validateMotion(structuredClone(raw)).warnings;
    const cleanWarnings = validateMotion(structuredClone(clean)).warnings;
    if (rawWarnings.length || cleanWarnings.length) throw new Error(`${sign.id}: puppet warnings: ${[...rawWarnings, ...cleanWarnings].join("; ")}`);
    summary.signs[sign.id] = { source_path: sign.source_path, raw_path: sign.raw_path,
      clean_path: sign.clean_path, report_dir: sign.report_dir, comparison_path: sign.comparison_path,
      strict_valid: true, puppet_valid: true, ...stats(clean) };
    if (render) run(process.execPath, [join(root, "puppet/render.mjs"), "--motion", cleanPath,
      "--view", "sidebyside", "--video", source, "--closeup",
      "--out", join(root, sign.comparison_path)], root, env);
  }

  const catalogPath = join(root, manifest.local_catalog_path);
  writeFileSync(catalogPath, JSON.stringify(localCatalog, null, 2));
  const audit = await auditVerifiedCatalog(localCatalog, { root });
  if (!audit.valid) throw new Error(`Local catalog audit failed: ${JSON.stringify(audit.failures)}`);

  for (const sequence of manifest.sequences) {
    const plan = JSON.parse(readFileSync(join(root, sequence.plan_path), "utf8"));
    const playback = await loadPlayback(plan, localCatalog, createMotionLoader({ root }));
    if (playback.status !== "ready") throw new Error(`${sequence.id}: ${JSON.stringify(playback.blocked)}`);
    const composed = join(root, sequence.motion_path);
    mkdirSync(dirname(composed), { recursive: true });
    const staged = playback.items.map((item, index) => {
      const path = join(root, "out/demo/staged", `${sequence.id}-${index}.clean.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(item.motion));
      return path;
    });
    const composeResult = spawnSync(process.execPath, ["--experimental-strip-types", join(root, "puppet/compose.mjs"),
      "--out", composed, "--fps", String(playback.items[0].motion.fps), "--blend", "0.2", ...staged],
    { cwd: root, env, encoding: "utf8" });
    if (composeResult.error) throw composeResult.error;
    if (composeResult.status !== 0) throw new Error(`${sequence.id}: compose failed: ${composeResult.stderr}`);
    const composedReport = JSON.parse(composeResult.stdout.trim());
    const motion = JSON.parse(readFileSync(composed, "utf8"));
    const warnings = validateMotion(structuredClone(motion)).warnings;
    if (warnings.length) throw new Error(`${sequence.id}: puppet warnings: ${warnings.join("; ")}`);
    summary.sequences[sequence.id] = { status: "ready", plan_path: sequence.plan_path,
      ids: playback.items.map((item) => item.motion_id), segments: composedReport.segments,
      motion_path: sequence.motion_path, render_path: sequence.render_path,
      fps: motion.fps, frames: motion.frames.length };
    if (render) run(process.execPath, [join(root, "puppet/render.mjs"), "--motion", composed,
      "--view", "vrm", "--out", join(root, sequence.render_path)], root, env);
  }
  writeFileSync(join(root, manifest.local_summary_path), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ catalog: manifest.local_catalog_path, summary: manifest.local_summary_path,
    signs: Object.keys(summary.signs), sequences: Object.keys(summary.sequences), rendered: render }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
