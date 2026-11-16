// Joint-limit violations and finger overlaps in the tracked hands of motion files (the input, before any solver).
//   node --experimental-strip-types puppet/scripts/hand-limits.ts out/motion/wlasl/hello-aaf4c6.clean.json [...]
// Prints per file: hand-frames, joints outside src/hand.ts LIMITS (1 degree slack), overlapping neighbour fingers,
// and which joints break the limits most.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { countOverlaps, countViolations, type V3 } from "../src/hand.ts";

const files = process.argv.slice(2);
if (!files.length) { console.error("usage: hand-limits.ts motion.json [...]"); process.exit(1); }
let totV = 0, totO = 0, totF = 0;
for (const file of files) {
  const m = JSON.parse(readFileSync(file, "utf8"));
  let v = 0, o = 0, n = 0;
  const hist: Record<string, number> = {};
  for (const f of m.frames) for (const side of ["left", "right"] as const) {
    const h: V3[] | null = f[`${side}HandWorld`] ?? f[`${side}Hand`];
    if (!h) continue;
    n++;
    const c = countViolations(h, side);
    v += c.count;
    for (const j of c.joints) { const k = j.replace(/ -?\d+°$/, ""); hist[k] = (hist[k] ?? 0) + 1; }
    o += countOverlaps(h, side);
  }
  totV += v; totO += o; totF += n;
  const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c]) => `${k} ${c}`).join(", ");
  console.log(`${basename(file).padEnd(28)} hand-frames ${String(n).padStart(4)}  violations ${String(v).padStart(4)}  overlaps ${String(o).padStart(3)}  ${top}`);
}
if (files.length > 1) console.log(`TOTAL hand-frames ${totF}, violations ${totV}, overlaps ${totO}`);
