// Sign -> voice: turn the signs read so far (2-5 glosses, each with the recognizer's top guesses) into one natural
// English sentence, and say whether they already make sense together. One small structured-output call per new sign.
//
//   POST /api/compose  {signs: [{text, options?: [{text, confidence}]}]}  ->  {makes_sense, sentence, picked, latency_ms, model}
//
// Only the recognized words are sent to OpenAI (store: false), never landmarks or video. Same key as the agent layer.

import { createHash } from "node:crypto";

export const COMPOSE_ROUTE = "/api/compose";
export const DEFAULT_COMPOSE_MODEL = "gpt-5.4-mini";
const MAX_SIGNS = 8;
const MAX_OPTIONS = 3;

const INSTRUCTIONS = `You voice a deaf person's ASL signs as spoken English.
You get the signs recognized so far, in order. Each position lists the recognizer's guesses, best first, with confidence.
Pick one guess per position (prefer the first unless another clearly makes a more meaningful message), then:
- makes_sense: ASL is short and drops small words, so be generous: true as soon as the picked signs carry a clear
  message a listener would understand, even with just 2 signs ("ME HUNGRY" -> "I'm hungry.", "WHERE BATH" ->
  "Where is the bathroom?", "THANK-YOU JUDGE" -> "Thank you, judges.", "HELP PLEASE" -> "Please help me.").
  False only if it is clearly unfinished (ends on a word that needs more, like "WANT", "GO-TO", "THE") or the
  signs don't fit together into any sensible message.
- sentence: the most natural short first-person English sentence for the picked signs (ASL grammar -> English grammar:
  add articles, verbs "to be", tense, question marks). Never add facts that were not signed. Always fill it, even if
  makes_sense is false (best effort).
- picked: the index of the guess you used for each position.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["makes_sense", "sentence", "picked"],
  properties: {
    makes_sense: { type: "boolean" },
    sentence: { type: "string" },
    picked: { type: "array", items: { type: "integer" } },
  },
};

/** Validate the request body into [{text, options:[{text, confidence}]}]. Throws {status, code, message}. */
export function parseSigns(body) {
  const bad = (message) => Object.assign(new Error(message), { status: 400, code: "bad_request" });
  if (!body || typeof body !== "object" || !Array.isArray(body.signs)) throw bad("body must be {signs: [{text, options?}]}");
  if (!body.signs.length) throw bad("signs is empty");
  if (body.signs.length > MAX_SIGNS) throw bad(`at most ${MAX_SIGNS} signs`);
  return body.signs.map((s) => {
    const text = typeof s?.text === "string" ? s.text.trim().slice(0, 40) : "";
    if (!text) throw bad("every sign needs a text");
    const options = (Array.isArray(s.options) ? s.options : [])
      .filter((o) => typeof o?.text === "string" && o.text.trim())
      .slice(0, MAX_OPTIONS)
      .map((o) => ({ text: o.text.trim().slice(0, 40), confidence: Number.isFinite(o.confidence) ? Math.round(o.confidence * 100) / 100 : null }));
    return { text, options: options.length ? options : [{ text, confidence: null }] };
  });
}

/**
 * @param {object} o
 * @param {{responses: {create: Function}}} o.client  OpenAI client (or a fake with the same shape, for tests)
 * @param {string} [o.model]      COMPOSE_MODEL env or DEFAULT_COMPOSE_MODEL
 * @param {number} [o.timeoutMs]  default 4000
 */
export function createComposer(o) {
  if (!o?.client?.responses?.create) throw new TypeError("createComposer needs an OpenAI client");
  const model = o.model ?? process.env.COMPOSE_MODEL ?? DEFAULT_COMPOSE_MODEL;
  const timeoutMs = o.timeoutMs ?? 4000;
  const cache = new Map();

  async function compose(signs) {
    const t0 = performance.now();
    const input = signs.map((s, i) => `${i + 1}. ${s.options.map((x, j) => `[${j}] ${x.text}${x.confidence == null ? "" : ` ${x.confidence}`}`).join("  ")}`).join("\n");
    const key = createHash("sha256").update(`${model}\n${input}`).digest("hex");
    if (cache.has(key)) return { ...cache.get(key), cached: true, latency_ms: 0 };
    const p = {
      model, instructions: INSTRUCTIONS, input, store: false, max_output_tokens: 300,
      text: { format: { type: "json_schema", name: "spoken_sentence", schema: SCHEMA, strict: true } },
    };
    if (/^(gpt-5|o\d)/.test(model)) p.reasoning = { effort: "none" }; else p.temperature = 0;
    const res = await o.client.responses.create(p, { signal: AbortSignal.timeout(timeoutMs), timeout: timeoutMs, maxRetries: 0 });
    const raw = res?.output_text;
    if (!raw) throw Object.assign(new Error("empty response"), { code: "empty_response" });
    const out = JSON.parse(raw);
    const picked = signs.map((s, i) => Math.min(Math.max(0, Number.isInteger(out.picked?.[i]) ? out.picked[i] : 0), s.options.length - 1));
    const result = { makes_sense: Boolean(out.makes_sense), sentence: String(out.sentence ?? "").trim(), picked, model };
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return { ...result, cached: false, latency_ms: Math.round(performance.now() - t0) };
  }

  return { compose, model, timeoutMs };
}
