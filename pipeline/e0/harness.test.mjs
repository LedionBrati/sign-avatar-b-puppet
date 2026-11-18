import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath } from "../../shared/ffmpeg.mjs";
import { parseOptions, guardPaid, runExperiment } from "./harness.mjs";
import { probeVideo } from "./video.mjs";
import { planModel } from "./models.mjs";

const exec = promisify(execFile);
const avatar = resolve(dirname(fileURLToPath(import.meta.url)), "../../assets/avatar/avatar-main.jpg");

async function fixture(dir, name, color) {
  const output = join(dir, name);
  await exec(ffmpegPath({ prefer: "bundled" }), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    `color=c=${color}:s=120x160:r=24:d=1`, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", output]);
  return output;
}

test("input parsing rejects missing video, unknown flags and conflicting modes", () => {
  assert.throws(() => parseOptions([]), /--puppet/);
  assert.throws(() => parseOptions(["--puppet", "x.mp4", "--typo"]), /Unknown/);
  assert.throws(() => parseOptions(["--puppet", "x.mp4", "--execute", "--dry-run"]), /either/);
});

test("ffprobe reports real dimensions, fps, duration, frame count and aspect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e0-probe-"));
  const video = await fixture(dir, "fixture.mp4", "green");
  const info = await probeVideo(video);
  assert.equal(info.width, 120); assert.equal(info.height, 160);
  assert.equal(info.fps, 24); assert.equal(info.frame_count, 24);
  assert.equal(info.aspect_ratio, "3:4");
  assert.ok(info.duration_seconds > 0.9 && info.duration_seconds < 1.1);
  await assert.rejects(probeVideo(join(dir, "missing.mp4")));
  await assert.rejects(probeVideo(join(dir, "wrong.avi")), /Expected an MP4/);
});

test("paid path requires single model, authorization, known price and sufficient budget", () => {
  const meta = { duration_seconds: 6 };
  const recast = planModel("recast", meta);
  const base = { execute: true, model: "recast", source: "source.mp4", "max-usd": "5" };
  assert.throws(() => guardPaid({ ...base, model: "all" }, recast), /one --model/);
  assert.throws(() => guardPaid(base, recast), /authorize-paid/);
  assert.throws(() => guardPaid({ ...base, "authorize-paid": "E0-PAID", "max-usd": "0.10" }, recast), /exceeds/);
  assert.throws(() => guardPaid({ ...base, "authorize-paid": "E0-PAID", "max-usd": "31" }, recast), /<=30/);
  assert.throws(() => guardPaid({ ...base, model: "dreamactor", "authorize-paid": "E0-PAID" }, planModel("dreamactor", meta)), /disabled/);
});

test("dry-run without FAL_KEY writes reports and never invokes paid code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e0-dry-"));
  const puppet = await fixture(dir, "puppet.mp4", "blue");
  const source = await fixture(dir, "source.mp4", "green");
  const generated = await fixture(dir, "generated.mp4", "red");
  const oldKey = process.env.FAL_KEY;
  delete process.env.FAL_KEY;
  try {
    const runDir = join(dir, "report");
    const result = await runExperiment(parseOptions(["--puppet", puppet, "--source", source,
      "--generated", generated, "--avatar", avatar, "--model", "all", "--run-dir", runDir]));
    assert.equal(result.report.mode, "dry-run");
    assert.equal(result.report.paid, null);
    assert.equal(result.report.models.length, 4);
    assert.equal(result.report.models[0].eligible, false); // 1s is below Recast's 5s minimum.
    assert.equal(result.report.comparison.panels.length, 3);
    const comparison = await probeVideo(join(runDir, "comparison.mp4"));
    assert.equal(comparison.width, 1920); assert.equal(comparison.height, 480);
    const json = JSON.parse(await readFile(join(runDir, "result.json"), "utf8"));
    const markdown = await readFile(join(runDir, "report.md"), "utf8");
    assert.equal(json.status, "comparison_unreviewed");
    assert.match(markdown, /Manual ASL evaluation/);
    assert.match(markdown, /Judgment: \*\*not evaluated\*\*/);
    await assert.rejects(runExperiment(parseOptions(["--puppet", puppet, "--avatar", avatar,
      "--run-dir", runDir])), /already exists/);
  } finally {
    if (oldKey === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = oldKey;
  }
});
