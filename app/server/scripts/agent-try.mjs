// Dev CLI: run the agent planner directly (no server) and print plan, safety, latency, tokens. The key is never printed.
//   OPENAI_API_KEY_FILE=path node app/server/scripts/agent-try.mjs "Thanks a lot, catch you later" [--vocab clips|dictionary] [--model id]
import OpenAI from "openai";
import { loadEnglishWords, loadVocab } from "../../../translate/node.mjs";
import { createAgent } from "../lib/agent.mjs";
import { loadApiKey, redactor } from "../lib/secrets.mjs";
import { loadClipSets, parseClipsDirs } from "../lib/clips.mjs";
import { assessSigning } from "../lib/semantic-safety.mjs";
import { virtualClips } from "../lib/eval-vocab.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const vocabSpec = flag("--vocab", "clips");
const model = flag("--model", process.env.OPENAI_MODEL);
const texts = args.length ? args : ["Thanks a lot, catch you later"];

const { key, error } = loadApiKey();
if (!key) { console.error(error ?? "set OPENAI_API_KEY or OPENAI_API_KEY_FILE"); process.exit(1); }
const redact = redactor(key);
const clips = vocabSpec === "clips" ? loadClipSets(parseClipsDirs()) : null;
const vocab = clips ? [...clips.signs.values()].map(({ motion_id, gloss }) => ({ motion_id, gloss })) : loadVocab(vocabSpec);
const gateClips = clips ?? virtualClips(vocab);
const englishWords = loadEnglishWords();
const agent = createAgent({ client: new OpenAI({ apiKey: key, maxRetries: 0 }), model, secrets: [key], englishWords });
console.log(`model ${agent.model}, vocab ${vocab.length} signs (${vocabSpec})`);
for (const text of texts) {
  const r = await agent.plan(text, vocab);
  if (!r.ok) { console.log(`${text}\n  FAIL ${r.code}: ${redact(r.error)} (${r.latency_ms} ms)`); continue; }
  const safety = assessSigning(text, r.plan, gateClips);
  const seq = r.plan.items.map((i) => (i.type === "sign" ? i.motion_id : `fs:${i.word}`) + (i.match.method === "semantic" ? "~" : "")).join(" ");
  console.log(`${text}\n  ${seq || "(nothing)"} | unsupported: ${r.plan.unsupported_tokens.join(", ") || "-"} | ${safety.status}` +
    `\n  paraphrase: ${r.paraphrase} | notes: ${r.notes}` +
    `\n  ${r.latency_ms} ms, tokens in ${r.usage?.input_tokens} (cached ${r.usage?.cached_tokens}) out ${r.usage?.output_tokens}` +
    (r.rejected.length ? `\n  rejected: ${JSON.stringify(r.rejected)}` : ""));
}
