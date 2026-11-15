// Live eval of the hybrid local -> agent routing against a RUNNING server (paid API calls: one per sentence the
// local translator cannot fully sign; cache hits are free). Prints a markdown table + writes JSON.
//   API_URL=http://127.0.0.1:8797 node app/server/scripts/agent-eval.mjs clips|dictionary [out.json]
import { writeFileSync } from "node:fs";

const SETS = {
  clips: [
    "I've had a headache since yesterday", "Thanks a lot, catch you later", "Hi, I'm Maria", "Where does it hurt?",
    "Can you help me find a doctor?", "Hello, thank you.", "Hey there!", "See ya later!", "Hello, my name is Maria.",
    "Where does your head hurt?", "Thank you so much!", "Good to see you.", "Bye, see you soon.", "Hello, nice to meet you.",
    "Where is the bathroom?", "My stomach hurts.", "Does it hurt here?", "I don't feel well.", "Thanks, see you later!",
    "Where are you?", "What's your name?", "Hello! Long time no see.", "My back hurts a lot.", "Where do I catch the bus?",
    "Turn right at the bank.",
  ],
  dictionary: [
    "I've had a headache since yesterday", "Thanks a lot, catch you later", "Hi, I'm Maria", "Can you help me find a doctor?",
    "Where is the nearest pharmacy?", "I feel dizzy and tired.", "My spouse needs help.", "I am exhausted.",
    "How much does the ticket cost?", "Where is the train station?", "Please call an ambulance.", "I'm allergic to penicillin.",
    "Could you speak slower, please?", "Nice to meet you, have a good day!", "I lost my passport.",
  ],
};
const set = process.argv[2] ?? "clips";
const out = process.argv[3];
const base = (process.env.API_URL ?? "http://127.0.0.1:8797").replace(/\/$/, "");
const health = await (await fetch(`${base}/api/health`)).json();
if (health.agent !== "ready") { console.error("server agent is not ready"); process.exit(1); }

const summarize = (plan) => plan.items.map((i) => (i.type === "sign" ? i.motion_id : `fs:${i.word}`) + (i.match?.method === "semantic" ? "~" : "")).join(" ");
const rows = [];
for (const text of [...SETS[set], SETS[set][1]]) {               // last one repeats: cache hit
  const t0 = performance.now();
  const res = await fetch(`${base}/api/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, agent: "auto" }) });
  const body = await res.json();
  const wall_ms = Math.round(performance.now() - t0);
  const a = body.agent;
  rows.push({
    text, winner: body.translator, status: body.safety?.status, wall_ms, model: a?.model ?? null,
    local: a ? (a.used ? a.local_plan : summarize(body.plan)) : summarize(body.plan), local_status: a?.local_status ?? body.safety?.status,
    local_unsupported: a?.used ? undefined : body.plan.unsupported_tokens,
    agent: a ? (a.used ? summarize(body.plan) : a.plan ?? null) : null, agent_status: a?.status ?? null,
    agent_unsupported: a?.used ? body.plan.unsupported_tokens : undefined,
    paraphrase: a?.paraphrase ?? null, notes: a?.notes ?? null, agent_ms: body.timings?.agent_ms ?? null, cached: a?.cached ?? null,
    usage: a?.usage ?? null, rejected: a?.rejected ?? [], error: a?.code ? `${a.code}` : null, reasons: body.safety?.reasons?.map((r) => r.code),
  });
  process.stderr.write(".");
}
process.stderr.write("\n");

const called = rows.filter((r) => r.agent_ms != null && !r.cached);
const lat = called.map((r) => r.agent_ms).sort((x, y) => x - y);
const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)] : null;
const tok = called.reduce((s, r) => ({ in: s.in + (r.usage?.input_tokens ?? 0), cached: s.cached + (r.usage?.cached_tokens ?? 0), out: s.out + (r.usage?.output_tokens ?? 0) }), { in: 0, cached: 0, out: 0 });
const summary = {
  set, model: rows.find((r) => r.usage)?.model, sentences: rows.length, agent_calls: called.length,
  agent_wins: rows.filter((r) => r.winner === "agent").length, rejected_items: rows.reduce((s, r) => s + r.rejected.length, 0),
  failures: rows.filter((r) => r.error).length, p50_ms: pct(50), p95_ms: pct(95),
  tokens: tok, avg_in: called.length ? Math.round(tok.in / called.length) : 0, avg_out: called.length ? Math.round(tok.out / called.length) : 0,
};
console.log(`| # | sentence | local plan (status) | agent plan (status) | winner | agent ms | tokens in/cached/out |`);
console.log(`|---|---|---|---|---|---|---|`);
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.text} | ${r.local || "-"} (${r.local_status}) | ${r.agent === null ? "not called" : `${r.agent || "-"} (${r.agent_status})`} | ${r.winner} | ${r.agent_ms ?? "-"}${r.cached ? " (cache)" : ""} | ${r.usage && !r.cached ? `${r.usage.input_tokens}/${r.usage.cached_tokens}/${r.usage.output_tokens}` : "-"} |`));
console.log("\n" + JSON.stringify(summary));
if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
