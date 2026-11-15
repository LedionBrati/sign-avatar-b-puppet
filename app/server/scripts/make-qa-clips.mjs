// Test-only MP4 clips for browser/API integration. These colored cards are NOT ASL.
// FFMPEG=/path/to/ffmpeg node app/server/scripts/make-qa-clips.mjs [output-dir]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const out = resolve(process.argv[2] ?? "out/qa-clips");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const colors = { HELLO: "#1d4ed8", THANK_YOU: "#7c3aed", YES: "#15803d", NO: "#b91c1c" };
const ids = ["HELLO", "THANK_YOU", "YES", "NO", "I", "WANT", "THAT", "TURN", "RIGHT", "BANK",
  "YOU", "PAY", "FINE", "MY", "HUSBAND", "NEED", "HELP", "NAME"];
mkdirSync(out, { recursive: true });
for (const [id, color] of Object.entries(colors)) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    `color=c=${color}:s=320x420:r=24`, "-t", "1", "-vf",
    `drawtext=text='SYNTHETIC NON-ASL ${id}':fontcolor=white:fontsize=19:x=12:y=200`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", join(out, `${id}.mp4`)], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`ffmpeg failed creating synthetic ${id} clip`);
}
const manifest = Object.fromEntries(ids.map((id) => [id, {
  gloss: id.replaceAll("_", " "), file: `${id in colors ? id : "YES"}.mp4`, seconds: 1,
  qa_fixture: "synthetic colored card; not ASL or a signing asset",
}]));
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Created ${ids.length} synthetic test entries in ${out}. Never use them as ASL signs.`);
