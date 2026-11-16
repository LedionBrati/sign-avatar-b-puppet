// Render speed benchmark: the same motion through render.mjs with each setting, one after the other.
//   node puppet/scripts/bench.mjs --motion phr-3.clean.json --out-dir out/bench [--gpu] [--only name1,name2] [--frames N]
// Writes <out-dir>/bench.json and prints a table: seconds per frame and fps per setting, plus the
// joint-limit violations of the shown hands. Heavy: run it on a spare machine (puppet/modal_render.py::bench).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n, fb) => { const i = argv.indexOf(`--${n}`); return i === -1 ? fb : argv[i + 1]; };
const motion = resolve(opt("motion"));
const outDir = resolve(opt("out-dir", "out/bench"));
const gpu = argv.includes("--gpu");
const only = opt("only", null)?.split(",");
const frames = opt("frames", null);

// name -> render.mjs flags. "vrm-png" is the old pipeline (anime VRM, PNG capture), the baseline.
const CONFIGS = {
  "vrm-png": ["--capture", "png"],
  "signer-png": ["--avatar", "signer", "--capture", "png"],
  "signer-jpeg": ["--avatar", "signer"],
  "signer-jpeg-noaa": ["--avatar", "signer", "--aa", "0"],
  "signer-lite-noaa": ["--avatar", "signer", "--aa", "0", "--lite"],
  "signer-lite-noaa-3pass": ["--avatar", "signer", "--aa", "0", "--lite", "--passes", "rgb,depth,normal"],
  "signer-3pass": ["--avatar", "signer", "--passes", "rgb,depth,normal"],
  "signer-raw": ["--avatar", "signer", "--capture", "raw"],
};

mkdirSync(outDir, { recursive: true });
const rows = [];
for (const [name, flags] of Object.entries(CONFIGS)) {
  if (only && !only.includes(name)) continue;
  const out = join(outDir, `bench-${name}${gpu ? "-gpu" : ""}.mp4`);
  const args = [join(here, "render.mjs"), "--motion", motion, "--view", "vrm", "--out", out, ...flags, ...(gpu ? ["--gpu"] : [])];
  if (frames) args.push("--frames", frames);
  process.stdout.write(`${name.padEnd(24)} `);
  try {
    execFileSync(process.execPath, args, { stdio: ["ignore", "ignore", "inherit"] });
    const r = JSON.parse(readFileSync(out.replace(/\.mp4$/, ".json"), "utf8"));
    const row = { name, flags: flags.join(" "), webgl: r.webgl, frames: r.frames, seconds: r.seconds, s_per_frame: r.seconds_per_frame,
      fps: +(r.frames / r.seconds).toFixed(2), violations: r.hand_limits?.violations ?? null, overlaps: r.hand_limits?.overlaps ?? null };
    rows.push(row);
    console.log(`${row.s_per_frame.toFixed(3)} s/frame  ${row.fps} fps  (${row.webgl})  violations ${row.violations}`);
  } catch (e) {
    rows.push({ name, flags: flags.join(" "), error: String(e.message ?? e).slice(0, 300) });
    console.log("FAILED");
  }
}
writeFileSync(join(outDir, "bench.json"), JSON.stringify({ motion, gpu, rows }, null, 1) + "\n");
console.log(`wrote ${join(outDir, "bench.json")}`);
