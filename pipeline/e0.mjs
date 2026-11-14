#!/usr/bin/env node
import { parseOptions, runExperiment } from "./e0/harness.mjs";

if (process.argv.includes("--help") || process.argv.length === 2) {
  console.log(`E0 puppet-to-repaint experiment harness

Dry run (default; no API key or upload):
  node pipeline/e0.mjs --puppet /path/to/nikos-puppet.mp4 --source references/how2sign/judy.mp4 --model all

Inspect an existing generated file and make a three-panel comparison:
  node pipeline/e0.mjs --puppet PUPPET.mp4 --source SIGNER.mp4 --generated REPAINT.mp4 --model recast

Paid execution is deliberately gated; requires explicit team authorization:
  node pipeline/e0.mjs --puppet PUPPET.mp4 --source SIGNER.mp4 --model recast --execute --authorize-paid E0-PAID --max-usd 5

Options: --avatar JPG|PNG, --model recast|kling|dreamactor|one_to_all|all,
         --resolution 768P|1080P (Recast), --run-dir DIR, --dry-run, --help
Reports: experiments/e0/runs/<timestamp>/{result.json,report.md,comparison.mp4 when available}
`);
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

try {
  const options = parseOptions(process.argv.slice(2));
  const { runDir, report } = await runExperiment(options);
  console.log(JSON.stringify({ run_dir: runDir, status: report.status, models: report.models,
    comparison: report.comparison?.path ?? null, paid: report.paid }, null, 2));
  if (report.status === "failed") process.exitCode = 1;
} catch (error) {
  console.error(`E0: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
