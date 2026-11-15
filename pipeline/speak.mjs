// English sentence -> sign plan -> joined avatar clip video. No remote model or API calls.
//
//   node pipeline/speak.mjs "Thank you, see you later." --clips out/realtime/clips --out out/speak/thanks.mp4
//        [--no-semantic] [--partial] [--offline]
//
// The vocab is exactly the clips in DIR/manifest.json, so every planned sign has a clip.
// If anything can't be signed (unsupported words, fingerspelling without letter clips),
// it is listed and nothing is rendered, unless --partial is passed: then the video contains
// only the supported signs and the skipped parts are still listed in the JSON.
// Letter clips, when they exist, are manifest entries FS_A..FS_Z (or any entry with letter: "A").

import { translate } from "../translate/index.mjs";
import { createNodeMatcher, defaultClipsDir, loadEnglishWords, vocabFromManifest } from "../translate/node.mjs";
import { joinClips, loadManifest } from "./lib/clips.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const valued = new Set(["--clips", "--out"]);
const text = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1])).join(" ");
const clipsDir = value("clips") ?? defaultClipsDir();
const out = value("out");
if (!text || !out || !clipsDir) {
  console.error('usage: speak.mjs "English sentence" --clips DIR --out OUT.mp4 [--no-semantic] [--partial] [--offline]');
  process.exit(2);
}

const t0 = performance.now();
const manifest = loadManifest(clipsDir);
const vocab = vocabFromManifest(manifest);
const letters = {};
for (const [id, e] of Object.entries(manifest)) {
  const letter = /^FS_([A-Z])$/.exec(id)?.[1] ?? (/^[A-Z]$/.test(e?.letter ?? "") ? e.letter : null);
  if (letter) letters[letter] = id;
}
const englishWords = (w) => loadEnglishWords().has(w); // loaded only if a leftover word needs it
const setup_ms = Math.round(performance.now() - t0);

const t1 = performance.now();
const plan = await translate(text, vocab, {
  semantic: !flag("no-semantic"), matcher: createNodeMatcher({ allowRemote: !flag("offline") }), englishWords,
});
const translate_ms = Math.round(performance.now() - t1);

const ids = [], skipped = [];
plan.items.forEach((item, index) => {
  if (item.type === "sign") {
    if (manifest[item.motion_id]) ids.push(item.motion_id);
    else skipped.push({ item_index: index, motion_id: item.motion_id, reason: "no clip for this sign" });
  } else {
    const missing = [...new Set([...item.word].filter((l) => !letters[l]))];
    if (missing.length) skipped.push({ item_index: index, fingerspell: item.word, reason: `no letter clips for ${missing.join(", ")}` });
    else ids.push(...[...item.word].map((l) => letters[l]));
  }
});
for (const token of plan.unsupported_tokens) skipped.push({ token, reason: "can't sign this yet (not in the clip set)" });

const summary = (extra) => JSON.stringify({ input_text: plan.input_text, ...extra, plan }, null, 2);
if (skipped.length && !flag("partial")) {
  console.error(`can't sign all of this yet: ${skipped.map((s) => s.token ?? s.fingerspell ?? s.motion_id).join(", ")} (pass --partial to render the rest)`);
  console.log(summary({ ok: false, skipped, timings: { setup_ms, translate_ms, ...plan.timings } }));
  process.exit(1);
}
if (!ids.length) {
  console.error("nothing in this sentence has a clip; no video made");
  console.log(summary({ ok: false, skipped, timings: { setup_ms, translate_ms, ...plan.timings } }));
  process.exit(1);
}
const joined = joinClips({ clipsDir, ids, out, manifest });
const total_ms = Math.round(performance.now() - t1);
if (skipped.length) console.error(`partial video: skipped ${skipped.map((s) => s.token ?? s.fingerspell ?? s.motion_id).join(", ")}`);
console.log(summary({
  ok: joined.ok, partial: skipped.length > 0, out, clips: ids, skipped, video_seconds: joined.video_seconds,
  timings: { translate_ms, assemble_ms: joined.assemble_ms, total_ms, setup_ms, process_ms: Math.round(performance.now()),
    rules_ms: plan.timings.rules_ms, semantic_ms: plan.timings.semantic_ms, model_load_ms: plan.timings.model_load_ms },
}));
if (!joined.ok) process.exit(1);
