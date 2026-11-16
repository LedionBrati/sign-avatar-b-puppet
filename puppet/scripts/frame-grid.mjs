// Still-frame grid from frame-aligned videos: one row per video, one column per frame number.
//   node puppet/scripts/frame-grid.mjs --out grid.png --frames 30,62,100 [--width 360] a.mp4 b.mp4 ...
// Each cell is the exact frame n (0-based) of that video, scaled to --width (default 360) wide.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fb) => { const i = argv.indexOf(`--${name}`); if (i === -1) return fb; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const out = resolve(opt("out"));
const frames = opt("frames").split(",").map(Number);
const width = Number(opt("width", 360));
const videos = argv;
if (!out || !frames.length || !videos.length) { console.error("usage: frame-grid.mjs --out grid.png --frames 1,2,3 a.mp4 [b.mp4 ...]"); process.exit(1); }

const inputs = videos.flatMap((v) => ["-i", v]);
const sel = frames.map((n) => `eq(n\\,${n})`).join("+");
const rows = videos.map((_, r) => `[${r}:v]select='${sel}',scale=${width}:-2,setsar=1,tile=${frames.length}x1[r${r}]`);
const graph = videos.length > 1 ? `${rows.join(";")};${videos.map((_, r) => `[r${r}]`).join("")}vstack=${videos.length}[g]` : rows[0].replace("[r0]", "[g]");
mkdirSync(dirname(out), { recursive: true });
execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[g]", "-frames:v", "1", "-update", "1", out], { stdio: "inherit" });
console.log(`wrote ${out}: ${videos.length} row(s) x ${frames.length} frame(s) [${frames.join(", ")}]`);
