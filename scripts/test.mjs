#!/usr/bin/env node
// Every test suite in the repo, one after another, with a summary at the end. Suites whose dependencies are not
// installed are skipped, not failed (e.g. the recognizer without uv, the pipeline without `npm ci` there).
//
//   npm test                 all suites
//   npm test -- server web   only the named ones

import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO, bold, fail, has, ok, run, step, warn } from "./lib.mjs";

const SUITES = [
  { name: "core", dir: "app/core", cmd: "npm test" },
  { name: "server", dir: "app/server", cmd: "npm test" },
  { name: "translate", dir: "translate", cmd: "npm test" },
  { name: "web", dir: "app/web", cmd: "npm test" },
  { name: "shared", dir: ".", cmd: 'node --test "shared/*.test.mjs"' },
  { name: "puppet", dir: "puppet", cmd: "npm test" },
  { name: "pipeline", dir: "pipeline", cmd: "npm run test:e0" },
  { name: "recognizer", dir: "app/recognizer", cmd: "uv run pytest -q", needs: "uv" },
];

const only = process.argv.slice(2);
const results = [];
for (const s of SUITES.filter((s) => !only.length || only.includes(s.name))) {
  step(`${s.name}  (${s.dir})`);
  const cwd = join(REPO, s.dir);
  if (s.needs ? !has(s.needs) : s.dir !== "." && !existsSync(join(cwd, "node_modules"))) {
    warn(`skipped: ${s.needs ?? "npm ci"} not available here`);
    results.push([s.name, "skipped"]);
    continue;
  }
  results.push([s.name, run(s.cmd, { cwd }).ok ? "pass" : "FAIL"]);
}

console.log(`\n${bold("Summary")}`);
for (const [name, r] of results) (r === "pass" ? ok : r === "skipped" ? warn : fail)(`${name.padEnd(11)} ${r}`);
process.exit(results.some(([, r]) => r === "FAIL") ? 1 : 0);
