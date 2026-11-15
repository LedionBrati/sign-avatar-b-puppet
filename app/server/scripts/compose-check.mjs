// Dev CLI: live quality check of the sign -> sentence prompt (lib/compose.mjs) on the noisy cases in
// test/fixtures/compose-cases.json. One real call per case (~17); the key is never printed.
//   OPENAI_API_KEY_FILE=path node app/server/scripts/compose-check.mjs [--model id] [--conversations]
// --conversations: short conversations (context.history) instead, one call each.
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
let { cases } = JSON.parse(readFileSync(new URL("../test/fixtures/compose-cases.json", import.meta.url), "utf8"));
const them = (text) => ({ who: "them", text });
const me = (text) => ({ who: "me", text });
const C = (history, signs, want, reject = []) => ({ context: { history }, signs, want, reject });
const CONVERSATIONS = [
  C([them("Hi!"), me("Hello!"), them("How are you?")], [[["good", 0.42], ["fine", 0.31], ["animal", 0.09], ["go", 0.05], ["dog", 0.03]]], "I'm good, thanks!"),
  C([them("What do you want to drink?")], [[["coffee", 0.55], ["cow", 0.12], ["drink", 0.1], ["cop", 0.04], ["milk", 0.03]]], "Coffee, please."),
  C([them("Where are you going after this?")], [[["home", 0.6], ["horse", 0.1], ["go", 0.08], ["hot", 0.04], ["house", 0.03]]], "I'm going home."),
  C([me("Hello!"), them("What's your name?")], [[["my", 0.7], ["mouse", 0.05], ["me", 0.02]], [["name", 0.5], ["nap", 0.1], ["no", 0.08]], [["#MARIA", 0.8]]], "My name is Maria."),
  C([them("Did you eat already?"), me("No."), them("Are you hungry?")], [[["yes", 0.62], ["yellow", 0.1], ["you", 0.04]], [["hungry", 0.38], ["hen", 0.2], ["cheek", 0.1]]], "Yes, I'm hungry."),
  C([them("Do you want some water?")], [[["yes", 0.7], ["yellow", 0.1], ["you", 0.05]], [["cat", 0.12], ["owl", 0.08], ["bird", 0.05]]], "Yes, please.", [false, true]),
];
if (args.includes("--conversations")) cases = CONVERSATIONS;

console.log(`model ${composer.model}, ${cases.length} cases\n`);
for (const c of cases) {
  const body = { signs: c.signs.map((opts, i) => ({ text: opts[0][0], options: opts.map(([text, confidence]) => ({ text, confidence })), reject: c.reject?.[i] === true })), context: c.context };
  const gloss = c.signs.map((opts) => opts.slice(0, 3).map(([t, p]) => `${t} ${p}`).join("|")).join("  ·  ");
  try {
    const r = await composer.compose(parseSigns(body), parseContext(body));
    const picks = `${r.picked.map((p, i) => (p < 0 ? "-" : c.signs[i][p][0])).join(" ")} [${r.picked}]${r.makes_sense ? "" : " (makes_sense false)"}`;
    const ctx = c.context?.history ? `[${c.context.history.map((t) => `${t.who}: ${t.text}`).join(" / ")}] ` : c.context ? "[ctx] " : "";
    console.log(`${ctx}${gloss}\n  picked: ${picks}\n  -> ${r.sentence}   (want ~ ${c.want}; ${r.latency_ms} ms)\n`);
  } catch (e) {
    console.log(`${gloss}\n  FAIL ${redact(e)}\n`);
  }
}
