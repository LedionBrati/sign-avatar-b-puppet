// Lists the OpenAI model IDs this key can use (IDs only; the key is never printed).
//   OPENAI_API_KEY_FILE=path/to/key.txt node app/server/scripts/agent-models.mjs [filter-regex]
import OpenAI from "openai";
import { loadApiKey, redactor } from "../lib/secrets.mjs";

const { key, error } = loadApiKey();
if (!key) { console.error(error ?? "set OPENAI_API_KEY or OPENAI_API_KEY_FILE"); process.exit(1); }
const redact = redactor(key);
const filter = new RegExp(process.argv[2] ?? "^(gpt|o\\d|chatgpt)", "i");
try {
  const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 15_000 });
  const ids = [];
  for await (const m of client.models.list()) ids.push(m.id);
  console.log(ids.filter((id) => filter.test(id)).sort().join("\n"));
  console.error(`${ids.length} models total`);
} catch (e) {
  console.error(redact(e));
  process.exit(1);
}
