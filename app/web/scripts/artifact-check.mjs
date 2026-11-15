// Checks the artifact build's suggested sentences sign fully with the bundled clips, through the same code path as
// src/artifact/shim.ts (translateRules -> planToPlaylist -> assessSigning). Run after npm run build:artifact:
//   node scripts/artifact-check.mjs ["another sentence" ...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translateRules } from "../../../translate/index.mjs";
import { planToPlaylist } from "../../server/lib/sign.mjs";
import { assessSigning } from "../../server/lib/semantic-safety.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../../out/artifact-app");
const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
// The bundled clip list is the first statement of the inlined script.
const clips = Function(`return ${html.match(/=(\[\{motion_id:.*?\}\])[,;]/)[1]}`)();
const signs = new Map(clips.map((c) => [c.motion_id, { ...c, url: c.file }]));
const sets = { signs, letters: new Map() };
const vocab = clips.map(({ motion_id, gloss }) => ({ motion_id, gloss }));
const src = fs.readFileSync(path.resolve(here, "../src/artifact/suggestions.ts"), "utf8");
const sentences = process.argv.length > 2 ? process.argv.slice(2) : [...src.matchAll(/^\s+"(.+)",$/gm)].map((m) => m[1]);
let bad = 0;
for (const text of sentences) {
  const plan = translateRules(text, vocab);
  const res = planToPlaylist(plan, sets);
  const safety = assessSigning(text, plan, sets);
  const missing = clips.filter((c) => !fs.existsSync(path.join(out, c.file)));
  const full = safety.status === "fully_supported" && res.playlist.length && !res.unsupported.length && !missing.length;
  if (!full) bad++;
  console.log(`${full ? "ok  " : "FAIL"} ${text.padEnd(36)} ${res.playlist.map((p) => p.gloss).join(" ")}  [${safety.status}${res.unsupported.length ? `; unsupported ${res.unsupported.join(",")}` : ""}${safety.reasons.length ? `; ${safety.reasons.map((r) => r.code).join(",")}` : ""}]`);
}
process.exit(bad ? 1 : 0);
