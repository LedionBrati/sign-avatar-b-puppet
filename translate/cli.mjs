#!/usr/bin/env node
// node translate/cli.mjs "English sentence" [--vocab clips|dictionary|PATH] [--no-semantic] [--json]
//                        [--threshold 0.7] [--offline] [--warm]
// Prints the sign plan and timings (rules ms, semantic ms, model-load ms reported separately).
// --warm runs the sentence twice in one process and reports the second (warm) run as well.

import { translate } from "./index.mjs";
import { createNodeMatcher, loadEnglishWords, loadVocab } from "./node.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const valued = new Set(["--vocab", "--threshold"]);
const text = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1])).join(" ");
if (!text) {
  console.error('usage: cli.mjs "English sentence" [--vocab clips|dictionary|PATH] [--no-semantic] [--json] [--threshold N] [--offline] [--warm]');
  process.exit(2);
}

const t0 = performance.now();
const vocab = loadVocab(value("vocab", "clips"));
const englishWords = loadEnglishWords(); // eager here so setup_ms, not rules_ms, pays the ~0.3-1 s load
const setup_ms = Math.round(performance.now() - t0);
const threshold = value("threshold") ? Number(value("threshold")) : undefined;
const matcher = createNodeMatcher({ allowRemote: !flag("offline"), ...(threshold ? { threshold } : {}) });
const options = { semantic: !flag("no-semantic"), matcher, englishWords, threshold };

const t1 = performance.now();
const plan = await translate(text, vocab, options);
plan.timings.total_ms = Math.round(performance.now() - t1);
plan.timings.setup_ms = setup_ms;
let warm;
if (flag("warm")) {
  const t2 = performance.now();
  warm = await translate(text, vocab, options);
  warm.timings.total_ms = Math.round((performance.now() - t2) * 1000) / 1000;
}

if (flag("json")) {
  console.log(JSON.stringify(warm ? { plan, warm_timings: warm.timings } : plan, null, 2));
} else {
  const show = (it) => it.type === "fingerspell" ? `fs:${it.word}`
    : `${it.motion_id}${it.match.method === "exact" || it.match.method === "phrase" ? "" : `(${it.match.method}${it.match.score !== undefined ? " " + it.match.score : ""})`}`;
  console.log(`input:       ${plan.input_text}`);
  console.log(`vocab:       ${vocab.length} signs from ${vocab.source}`);
  console.log(`signs:       ${plan.items.map(show).join("  ") || "(none)"}`);
  if (plan.nonmanual_markers.length) console.log(`markers:     ${plan.nonmanual_markers.map((m) => `${m.type}[${m.from}-${m.to}]`).join(" ")}`);
  if (plan.unsupported_tokens.length) console.log(`unsupported: ${plan.unsupported_tokens.join(", ")}  (can't sign this yet)`);
  if (plan.dropped_tokens.length) console.log(`dropped:     ${plan.dropped_tokens.join(", ")}`);
  for (const w of plan.warnings) console.log(`warning:     ${w}`);
  const t = plan.timings;
  console.log(`timings:     rules ${t.rules_ms} ms, semantic ${t.semantic_ms} ms, model load ${t.model_load_ms} ms` +
    (t.vocab_cache ? `, vocab embeddings ${t.vocab_embed_ms} ms (${t.vocab_cache})` : "") + `, total ${t.total_ms} ms (setup ${setup_ms} ms)`);
  if (warm) console.log(`warm run:    rules ${warm.timings.rules_ms} ms, semantic ${warm.timings.semantic_ms} ms, total ${warm.timings.total_ms} ms`);
}
