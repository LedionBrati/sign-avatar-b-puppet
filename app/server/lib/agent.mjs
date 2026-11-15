// LLM agent layer: English -> sign plan BY MEANING (paraphrase into the signs that exist), via OpenAI.
//
// The model only proposes. Code decides:
//   - every motion_id must be in the vocab passed in (unknown IDs are rejected, never invented);
//   - fingerspelling must spell the source word itself (A-Z);
//   - each sign's match method is re-derived locally: a sign the local rules would also pick for exactly those
//     words keeps that method (exact / phrase / lemma / synonym); anything else is a paraphrase -> "semantic",
//     which the safety gate (lib/semantic-safety.mjs) treats as needs_confirmation, like the local embeddings;
//   - every input word ends up signed, dropped (only the local DROP list) or unsupported - a content word the
//     model silently leaves out becomes unsupported, so the gate blocks the message;
//   - the plan must pass shared/contracts.mjs assertPlan.
// The result is an ordinary translator plan; the server runs it through the same playlist builder + gate.
// Sentence text is sent to OpenAI (store: false). The API key is never logged or returned (lib/secrets.mjs).

import { createHash } from "node:crypto";
import { assertPlan } from "../../../shared/contracts.mjs";
import { translateRules } from "../../../translate/index.mjs";
import { DROP, tokenize, toFingerspell, toMotionId } from "../../../translate/rules.mjs";
import { redactor } from "./secrets.mjs";

export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_TIMEOUT_MS = 6000;
const MARKERS = ["question_wh", "question_yn", "negation"];
const VERIFIED = new Set(["exact", "phrase", "lemma", "synonym"]);

/** Static instructions: identical for every request so the prompt prefix (instructions + vocab) is cacheable. */
export const INSTRUCTIONS = `You plan English -> ASL sign sequences for an avatar that can ONLY play the signs listed in VOCAB.
Translate by meaning, not word by word:
- Paraphrase into VOCAB signs when the exact word is missing ("catch you later" -> SEE YOU LATER, "headache" -> HEAD HURT if both exist).
- Use only IDs that appear in VOCAB, spelled exactly. Never make up an ID. If a meaning cannot be expressed with VOCAB, put that word's index in "unsupported" (do not guess).
- Choose the sense that fits the sentence; VOCAB notes in parentheses give senses.
- Order ASL-ish: time signs first; WH-question sign (WHERE, WHAT, ...) last; a question_wh marker spans the whole WH question; a yes/no question gets question_yn over its signs; a negation sign gets a negation marker from it to the end of its clause. Marker from/to are item indices (inclusive).
- Fingerspell names and proper nouns: type "fingerspell", letters = the word in A-Z only, id null.
- Drop words ASL does not sign: articles, am/is/are/was/were/be, do/does/did, "to", fillers.
- source = index of the input word the item renders. covers = every input word index whose meaning that item carries (include source). Each input word belongs to at most one item. Words that are neither covered, unsupported nor droppable are treated as lost.
- confidence: 0-1, how sure you are the sign keeps the intended meaning in this sentence.
- paraphrase: plain English of exactly what the signs say. notes: one short sentence on what was lost, assumed or simplified ("" if nothing).
Input words are numbered "index:word".`;

/** Strict JSON schema for the Responses API structured output. */
export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "markers", "unsupported", "paraphrase", "notes"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "id", "letters", "source", "covers", "confidence"],
        properties: {
          type: { type: "string", enum: ["sign", "fingerspell"] },
          id: { type: ["string", "null"], description: "VOCAB ID for type sign, else null" },
          letters: { type: ["string", "null"], description: "A-Z letters for type fingerspell, else null" },
          source: { type: "integer" },
          covers: { type: "array", items: { type: "integer" } },
          confidence: { type: "number" },
        },
      },
    },
    markers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "from", "to"],
        properties: { type: { type: "string", enum: MARKERS }, from: { type: "integer" }, to: { type: "integer" } },
      },
    },
    unsupported: { type: "array", items: { type: "integer" } },
    paraphrase: { type: "string" },
    notes: { type: "string" },
  },
};

const vocabInfo = new WeakMap();
/** Compact vocab line + hash + id map, computed once per vocab array. "ID" when the gloss is derivable, else "ID=gloss". */
export function describeVocab(vocab) {
  if (vocabInfo.has(vocab)) return vocabInfo.get(vocab);
  const byId = new Map();
  const parts = [];
  for (const v of vocab) {
    if (!v || typeof v.gloss !== "string" || !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(v.motion_id ?? "") || byId.has(v.motion_id)) continue;
    byId.set(v.motion_id, v);
    let s = toMotionId(v.gloss) === v.motion_id ? v.motion_id : `${v.motion_id}=${v.gloss}`;
    if (typeof v.sense === "string" && v.sense.trim()) s += ` (${v.sense.trim()})`;
    parts.push(s);
  }
  const text = `VOCAB (${parts.length} signs):\n${parts.join(", ")}`;
  const info = { text, byId, hash: createHash("sha256").update(text).digest("hex").slice(0, 16), count: parts.length };
  vocabInfo.set(vocab, info);
  return info;
}

/** Small LRU on a Map (insertion order = recency). */
export function lru(max = 200) {
  const m = new Map();
  return {
    get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
    set(k, v) { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); },
    get size() { return m.size; },
    clear() { m.clear(); },
  };
}

const isReasoningModel = (model) => /^(gpt-5|gpt-6|o\d)/i.test(model);
const clean = (word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const dropOnly = (word) => { const t = tokenize(word); return t.length > 0 && t.every((x) => DROP.has(x.w)); };

/**
 * @param {object} o
 * @param {{responses: {create: Function}}} o.client  OpenAI client (or a fake with the same shape, for tests)
 * @param {string} [o.model]          default OPENAI_MODEL env or DEFAULT_MODEL
 * @param {number} [o.timeoutMs]      total budget per plan() across attempts (default 6000)
 * @param {number} [o.retries]        extra attempts after a failure while budget remains (default 1)
 * @param {number} [o.cacheSize]      LRU entries (default 200)
 * @param {string[]} [o.secrets]      strings to redact from errors (the API key)
 * @param {Set<string>|Function} [o.englishWords]  same word list as the local translator (name detection)
 * @param {string} [o.reasoningEffort]  for reasoning models (default "none"; AGENT_REASONING env)
 */
export function createAgent(o) {
  if (!o?.client?.responses?.create) throw new TypeError("createAgent needs an OpenAI client");
  const model = o.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = o.retries ?? 1;
  const redact = redactor(...(o.secrets ?? []));
  const cache = lru(o.cacheSize ?? 200);
  const unsupportedParams = new Set();          // params this model rejected once (e.g. temperature); not sent again
  const effort = o.reasoningEffort ?? process.env.AGENT_REASONING ?? "none";
  const stats = { requests: 0, cache_hits: 0, failures: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0 };

  function params(vocabText, vocabHash, words) {
    const p = {
      model,
      instructions: INSTRUCTIONS,
      input: [
        { role: "developer", content: vocabText },               // static per vocab -> cacheable prefix
        { role: "user", content: words.map((w, i) => `${i}:${w}`).join(" ") },
      ],
      text: { format: { type: "json_schema", name: "sign_plan", schema: PLAN_SCHEMA, strict: true } },
      max_output_tokens: 1500,
      store: false,
      prompt_cache_key: `signlayer-agent-${vocabHash}`,
    };
    if (isReasoningModel(model)) { if (!unsupportedParams.has("reasoning")) p.reasoning = { effort }; }
    else if (!unsupportedParams.has("temperature")) p.temperature = 0;
    return p;
  }

  async function call(p, deadline) {
    const remaining = deadline - performance.now();
    const ac = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { ac.abort(); reject(Object.assign(new Error(`agent timed out after ${Math.round(remaining)} ms`), { code: "timeout" })); }, remaining);
    });
    try {
      return await Promise.race([o.client.responses.create(p, { signal: ac.signal, timeout: Math.max(1, Math.round(remaining)), maxRetries: 0 }), timeout]);
    } finally { clearTimeout(timer); }
  }

  /**
   * @returns {Promise<{ok: true, plan, paraphrase, notes, rejected, usage, latency_ms, cached, model, attempts}
   *                 | {ok: false, error: string, code: string, latency_ms, model, attempts}>}
   */
  async function plan(text, vocab, opts = {}) {
    const t0 = performance.now();
    const input = String(text).trim().replace(/\s+/g, " ");
    const words = input ? input.split(" ") : [];
    const v = describeVocab(vocab);
    const key = createHash("sha256").update(`${model}\n${v.hash}\n${input}`).digest("hex");
    const hit = cache.get(key);
    if (hit) { stats.cache_hits++; return { ...structuredClone(hit), cached: true, latency_ms: ms(performance.now() - t0) }; }
    if (!words.length) return fail("empty_text", "text is empty", t0, 0);
    if (!v.count) return fail("empty_vocab", "vocab is empty", t0, 0);

    const deadline = t0 + timeoutMs;
    let attempts = 0, lastError = null;
    while (attempts <= retries && deadline - performance.now() > (attempts ? 750 : 0)) {
      attempts++;
      stats.requests++;
      try {
        const res = await call(params(v.text, v.hash, words), deadline);
        const usage = res?.usage ? {
          input_tokens: res.usage.input_tokens ?? 0, output_tokens: res.usage.output_tokens ?? 0,
          cached_tokens: res.usage.input_tokens_details?.cached_tokens ?? 0,
        } : null;
        if (usage) { stats.input_tokens += usage.input_tokens; stats.output_tokens += usage.output_tokens; stats.cached_tokens += usage.cached_tokens; }
        if (res?.status && res.status !== "completed") throw Object.assign(new Error(`response ${res.status}${res.incomplete_details?.reason ? ` (${res.incomplete_details.reason})` : ""}`), { code: "incomplete" });
        const raw = res?.output_text ?? extractText(res);
        if (!raw) throw Object.assign(new Error("empty or refused response"), { code: "empty_response" });
        let proposal;
        try { proposal = JSON.parse(raw); } catch { throw Object.assign(new Error("response is not JSON"), { code: "bad_json" }); }
        const built = buildPlan(input, words, proposal, v.byId, vocab, { englishWords: opts.englishWords ?? o.englishWords, model });
        const result = { ok: true, ...built, usage, model, attempts, cached: false };
        cache.set(key, result);
        return { ...structuredClone(result), latency_ms: ms(performance.now() - t0) };
      } catch (error) {
        lastError = error;
        const status = error?.status;
        // A rejected optional parameter (temperature / reasoning) is retried once without it.
        const param = status === 400 && /temperature|reasoning/i.exec(String(error?.message ?? ""))?.[0]?.toLowerCase();
        if (param && !unsupportedParams.has(param)) { unsupportedParams.add(param); attempts--; continue; }
        if (status === 401 || status === 403 || status === 404 || (status === 400 && !param)) break;   // not retryable
      }
    }
    stats.failures++;
    return fail(lastError?.code ?? (lastError?.status ? `http_${lastError.status}` : "no_budget"), lastError ?? "no time budget left", t0, attempts);
  }

  function fail(code, error, t0, attempts) {
    return { ok: false, code: String(code), error: redact(error), latency_ms: ms(performance.now() - t0), model, attempts };
  }

  return { model, plan, stats, cache, timeoutMs, retries };
}

function extractText(res) {
  for (const item of res?.output ?? []) for (const c of item?.content ?? []) if (c?.type === "output_text" && c.text) return c.text;
  return null;
}

const ms = (x) => Math.round(x * 100) / 100;

/**
 * Model proposal -> validated translator plan (shared/contracts.mjs shape + the fields the safety gate reads).
 * Pure; exported for tests. Never adds a motion_id that is not in byId.
 */
export function buildPlan(input, words, proposal, byId, vocab, { englishWords, model } = {}) {
  const n = words.length;
  const inRange = (i) => Number.isInteger(i) && i >= 0 && i < n;
  const rejected = [];
  const warnings = [];
  const unsupportedIdx = new Set((Array.isArray(proposal?.unsupported) ? proposal.unsupported : []).filter(inRange));
  const claimed = new Set();
  const items = [];
  const keptIndex = [];                       // proposal item index -> plan item index (or -1)
  const literal = new Set();                  // word indices a verified sign renders literally (not "dropped")
  const rulesOpts = { englishWords };

  for (const [pi, raw] of (Array.isArray(proposal?.items) ? proposal.items : []).entries()) {
    keptIndex.push(-1);
    if (!raw || typeof raw !== "object" || !inRange(raw.source) || !clean(words[raw.source])) {
      rejected.push({ reason: "bad_source", id: raw?.id ?? null, source: raw?.source ?? null });
      continue;
    }
    // Several items may share words ("headache" -> HEAD HURT); each is checked on its own.
    const covers = [...new Set([raw.source, ...(Array.isArray(raw.covers) ? raw.covers : [])].filter(inRange))].sort((a, b) => a - b);
    const lose = () => covers.forEach((i) => { if (!dropOnly(words[i])) unsupportedIdx.add(i); });
    const source = clean(words[raw.source]);
    const confidence = Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0.5;

    if (raw.type === "fingerspell") {
      const letters = toFingerspell(raw.letters ?? "");
      if (!letters || letters !== toFingerspell(source)) {
        rejected.push({ reason: "fingerspell_mismatch", letters: raw.letters ?? null, source });
        lose();
        continue;
      }
      covers.forEach((i) => claimed.add(i));
      keptIndex[pi] = items.length;
      items.push({ type: "fingerspell", word: letters, source, source_index: raw.source, match: { method: "fingerspell", reason: "agent_name", by: "agent" } });
      continue;
    }
    if (raw.type !== "sign" || typeof raw.id !== "string") { rejected.push({ reason: "bad_item", id: raw.id ?? null, source }); lose(); continue; }
    let entry = byId.get(raw.id);
    if (!entry && byId.has(toMotionId(raw.id))) entry = byId.get(toMotionId(raw.id));     // "THANK YOU" for THANK_YOU: a spelling slip
    if (!entry) { rejected.push({ reason: "not_in_vocab", id: raw.id, source }); lose(); continue; }

    // Re-derive the match: would the local rules give exactly this sign for exactly these (non-dropped) words?
    const content = covers.filter((i) => !dropOnly(words[i]));
    let match = { method: "semantic", score: Math.round(confidence * 1000) / 1000, by: "agent" };
    // Literal candidates: one run of words (droppable words may sit inside it, as in "thank you" / "see you later").
    const contiguous = content.length > 0 &&
      words.slice(content[0], content.at(-1) + 1).every((w, k) => content.includes(content[0] + k) || dropOnly(w));
    if (contiguous && content.includes(raw.source)) {
      const span = words.slice(content[0], content.at(-1) + 1).map(clean).join(" ");
      const check = translateRules(span, vocab, rulesOpts);
      const only = check.items.length === 1 && !check.unsupported_tokens.length ? check.items[0] : null;
      if (only?.type === "sign" && only.motion_id === entry.motion_id && VERIFIED.has(only.match.method)) {
        match = { method: only.match.method, by: "agent", verified: "rules" };
        if (only.match.lemma) match.lemma = only.match.lemma;
        content.forEach((i) => literal.add(i));
      }
    }
    covers.forEach((i) => claimed.add(i));
    keptIndex[pi] = items.length;
    items.push({ type: "sign", gloss: entry.gloss, motion_id: entry.motion_id, source, source_index: raw.source, match });
  }

  // Every word: signed literally, carried by a (semantic) item, dropped (local DROP list only), or unsupported.
  const dropped = [];
  words.forEach((w, i) => {
    if (unsupportedIdx.has(i) || !clean(w)) return;
    if (dropOnly(w)) { if (!literal.has(i)) dropped.push(clean(w)); return; }  // reported, so the gate sees risky drops ("it")
    if (!claimed.has(i)) unsupportedIdx.add(i);
  });
  // A word the model listed as unsupported stays unsupported even if an item also claims it (conservative).
  const unsupported = [...unsupportedIdx].sort((a, b) => a - b).map((i) => clean(words[i])).filter(Boolean);

  const markers = [];
  for (const m of Array.isArray(proposal?.markers) ? proposal.markers : []) {
    if (!m || !MARKERS.includes(m.type)) continue;
    // Remap proposal item indices to kept plan items; drop markers that no longer cover anything.
    const kept = keptIndex.slice(Math.max(0, m.from), Math.max(0, m.to) + 1).filter((k) => k >= 0);
    if (Number.isInteger(m.from) && Number.isInteger(m.to) && m.from <= m.to && kept.length) markers.push({ type: m.type, from: kept[0], to: kept.at(-1) });
  }
  if (rejected.length) warnings.push(`agent proposed ${rejected.length} item(s) that failed validation (${[...new Set(rejected.map((r) => r.reason))].join(", ")}); their words are unsupported`);

  const plan = {
    input_text: input,
    items,
    nonmanual_markers: markers,
    unsupported_tokens: unsupported,
    caption: input,
    ok: items.length > 0,
    dropped_tokens: dropped,
    warnings,
    translator: {
      name: "agent/openai",
      model,
      approximate: "LLM paraphrase into available signs, validated in code; not ASL grammar; not signer-reviewed",
    },
  };
  if (plan.ok) assertPlan(plan);
  return {
    plan,
    paraphrase: typeof proposal?.paraphrase === "string" ? proposal.paraphrase.slice(0, 500) : "",
    notes: typeof proposal?.notes === "string" ? proposal.notes.slice(0, 500) : "",
    rejected,
  };
}
