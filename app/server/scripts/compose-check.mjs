// Dev CLI: live quality check of the sign -> sentence prompt (lib/compose.mjs) on the noisy cases in
// test/fixtures/compose-cases.json. One real call per case (~17); the key is never printed.
//   OPENAI_API_KEY_FILE=path node app/server/scripts/compose-check.mjs [--model id]
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { createComposer, parseContext, parseSigns } from "../lib/compose.mjs";
import { loadApiKey, redactor } from "../lib/secrets.mjs";

const args = process.argv.slice(2);
const mi = args.indexOf("--model");
const model = mi >= 0 ? args[mi + 1] : undefined;
const { key, error } = loadApiKey();
if (!key) { console.error(error ?? "set OPENAI_API_KEY or OPENAI_API_KEY_FILE"); process.exit(1); }
const redact = redactor(key);
const composer = createComposer({ client: new OpenAI({ apiKey: key, maxRetries: 0 }), model, timeoutMs: 15_000 });
const { cases } = JSON.parse(readFileSync(new URL("../test/fixtures/compose-cases.json", import.meta.url), "utf8"));

console.log(`model ${composer.model}, ${cases.length} cases\n`);
for (const c of cases) {
  const body = { signs: c.signs.map((opts) => ({ text: opts[0][0], options: opts.map(([text, confidence]) => ({ text, confidence })) })), context: c.context };
  const gloss = c.signs.map((opts) => opts.slice(0, 3).map(([t, p]) => `${t} ${p}`).join("|")).join("  ·  ");
  try {
    const r = await composer.compose(parseSigns(body), parseContext(body));
    const picks = `${r.picked.map((p, i) => (p < 0 ? "-" : c.signs[i][p][0])).join(" ")} [${r.picked}]${r.makes_sense ? "" : " (makes_sense false)"}`;
    console.log(`${c.context ? `[ctx] ` : ""}${gloss}\n  picked: ${picks}\n  -> ${r.sentence}   (want ~ ${c.want}; ${r.latency_ms} ms)\n`);
  } catch (e) {
    console.log(`${gloss}\n  FAIL ${redact(e)}\n`);
  }
}
