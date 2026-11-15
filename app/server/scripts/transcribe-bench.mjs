// Speech-to-text latency per model on real audio chunks (e.g. the tab-audio chunks scripts/verify-youtube.mjs keeps
// with KEEP_AUDIO=dir). Prints model, chunk, round-trip ms and text; the key is never printed.
//   OPENAI_API_KEY_FILE=path/to/key.txt node app/server/scripts/transcribe-bench.mjs dir [model,model,...]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { loadApiKey, redactor } from "../lib/secrets.mjs";
import { createTranscriber } from "../lib/transcribe.mjs";

const [dir, list = "gpt-4o-mini-transcribe,gpt-transcribe,gpt-4o-transcribe,whisper-1"] = process.argv.slice(2);
const { key, error } = loadApiKey();
if (!key || !dir) { console.error(error ?? "usage: transcribe-bench.mjs <dir of .webm chunks> [models]"); process.exit(1); }
const redact = redactor(key);
const client = new OpenAI({ apiKey: key, maxRetries: 0 });
const files = readdirSync(dir).filter((f) => /\.(webm|ogg|wav|mp3|m4a)$/.test(f)).sort();
for (const model of list.split(",")) {
  const t = createTranscriber({ client, model, secrets: [key], timeoutMs: 20_000 });
  const lat = [];
  for (const f of files) {
    const r = await t.transcribe(readFileSync(join(dir, f)), { mime: "audio/webm", language: "en" });
    if (r.ok) lat.push(r.latency_ms);
    console.log(`${model.padEnd(24)} ${f.padEnd(14)} ${String(Math.round(r.latency_ms)).padStart(5)} ms  ${r.ok ? r.text : `ERR ${r.code}: ${redact(r.error).slice(0, 80)}`}`);
  }
  lat.sort((a, b) => a - b);
  if (lat.length) console.log(`${model.padEnd(24)} median ${Math.round(lat[lat.length >> 1])} ms (min ${Math.round(lat[0])}, max ${Math.round(lat.at(-1))}, n=${lat.length})\n`);
}
