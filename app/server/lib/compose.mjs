// Sign -> voice: turn the signs read so far (1-8 glosses, each with up to 5 recognizer guesses + confidences) into one
// natural spoken English sentence. One small structured-output call per new sign; the client speaks the latest answer
// once the signer's hands rest.
//
//   POST /api/compose  {signs: [{text, options?: [{text, confidence}]}], context?: {said?: string[], heard?: string}}
//                      ->  {makes_sense, sentence, picked, latency_ms, model}     (picked[i] = -1: sign i was dropped)
//
// Only the recognized words (and the optional conversation context) are sent to OpenAI (store: false), never landmarks
// or video. The instructions + the recognizer's 250-label vocabulary are a fixed prefix, so prompt caching applies.

import { createHash } from "node:crypto";
import { SIGN_LABELS } from "./sign-vocab.mjs";

export const COMPOSE_ROUTE = "/api/compose";
export const DEFAULT_COMPOSE_MODEL = "gpt-5.4-mini";
const MAX_SIGNS = 8;
const MAX_OPTIONS = 5;
const MAX_SAID = 2;
const CACHE_SIZE = 300;

export const INSTRUCTIONS = `You are the voice of a deaf person who is signing ASL to a hearing person. A sign recognizer reads their signs
one at a time; you turn the signs so far into the ONE short English sentence that is spoken aloud for them.

Input: the signs in signing order. Each position lists the recognizer's guesses, best first, with confidence 0-1.
The recognizer only knows the vocabulary in the developer message and is often wrong: the right word is frequently the
2nd-5th guess, and a sign it does not know comes out as some unrelated low-confidence word.

1. picked: for each position, the index of the guess you use. Choose the combination of guesses that makes the most
   sensible, coherent message (and fits the conversation, if given). A confident top guess (>= 0.5) usually wins;
   with close or low confidences, prefer whichever guess makes sense with the other signs.
   Use -1 to DROP a position only when every guess is low-confidence (below about 0.15) and none fits the message.
   picked must match the sentence: a position you left out of the sentence is -1, and every picked word is in it.
2. sentence: what the signer means, as natural, complete, grammatical spoken English, in the first person.
   ASL drops small words and uses its own order (time first, topic first, question words last), so rebuild English
   grammar: add subjects, articles, "to be", tense, possessives, word order, and a question mark for questions.
   Say what a person would mean, the way a fluent speaker would say it, not a word-by-word reading: signs in a row
   are often two linked ideas ("SLEEPY BED" -> "I'm sleepy, I'm going to bed.", not "I'm sleepy in the bed.").
   Use only the meaning of the picked signs: never add content words, names, places or facts that were not signed.
   Never output a word list, a bare noun list ("Yes, milk."), a gloss, or a fragment that stops mid-thought ("I want the.", "Me go store.").
   If the signs do not form a full message, give the best short natural sentence the confident signs support.
   A single sign becomes a natural short phrase ("Hello!", "Thank you!", "Yes.", "Water, please.").
   One sentence, at most about 15 words.
3. makes_sense: true when the picked signs carry a clear message a listener would understand; false if it looks
   unfinished (ends on a word that needs more, like WANT or GO) or had to be guessed.

Context, when given, is the conversation so far: what the hearing person just said and what the signer said before.
Use it to choose between guesses and to turn short answers into a full natural reply to what was asked
(heard "Do you want juice?", signs YES -> "Yes, please."; signs YES WATER -> "Yes, I'd like some water."). Never voice
the context itself again.

Examples (gloss -> sentence):
ME HUNGRY -> I'm hungry.
WHERE BATHROOM -> Where is the bathroom?
YOU NAME WHAT -> What's your name?
TOMORROW ME GO STORE -> I'm going to the store tomorrow.
THANKYOU -> Thank you!
HELLO -> Hello!
MOTHER SICK -> My mother is sick.
ME LIKE DOG -> I like dogs.
YESTERDAY ME SEE GRANDMA -> I saw my grandma yesterday.
HELP PLEASE -> Please help me.
HURT WHERE -> Where does it hurt?
ME WANT WATER -> I'd like some water.
BROTHER HAVE CAR -> My brother has a car.
TIRED BED -> I'm tired, I'm going to bed.
ME WANT -> I want something.
Noisy guesses:
  1. [0] me 0.82  2. [0] hen 0.31 [1] hungry 0.28 [2] hat 0.1  ->  picked [0, 1], "I'm hungry."
  1. [0] hello 0.9  2. [0] zebra 0.07 [1] owl 0.06 [2] wolf 0.05  ->  picked [0, -1], "Hello!"
  1. [0] gift 0.4 [1] dad 0.35  2. [0] sick 0.6  ->  picked [1, 0], "My dad is sick."`;

/** The recognizer's whole vocabulary: a fixed developer message right after the instructions (cacheable prefix). */
export const VOCAB_MESSAGE = `Recognizer vocabulary (the only signs it can output; ${SIGN_LABELS.length} labels):
${SIGN_LABELS.join(", ")}
Label notes: thankyou = "thank you", minemy = "my/mine", hesheit = "he/she/it", weus = "we/us", haveto = "have to",
callonphone = "call (on the phone)", potty = "bathroom/toilet", glasswindow = "glass/window", owie = "hurt/ouch", shhh = "be quiet",
yourself = "you", TV = "television". A "#NAME" sign is a fingerspelled name or word; always use it as written.`;

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["makes_sense", "sentence", "picked"],
  properties: {
    makes_sense: { type: "boolean" },
    sentence: { type: "string" },
    picked: { type: "array", items: { type: "integer" } },
  },
};

const bad = (message) => Object.assign(new Error(message), { status: 400, code: "bad_request" });
const clean = (s, n) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** Validate the request body into [{text, options:[{text, confidence}]}] (1-8 signs, up to 5 options each). Throws {status, code, message}. */
export function parseSigns(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.signs)) throw bad("body must be {signs: [{text, options?}]}");
  if (!body.signs.length) throw bad("signs is empty");
  if (body.signs.length > MAX_SIGNS) throw bad(`at most ${MAX_SIGNS} signs`);
  return body.signs.map((s) => {
    const text = clean(s?.text, 40);
    if (!text) throw bad("every sign needs a text");
    const options = (Array.isArray(s.options) ? s.options : [])
      .filter((o) => typeof o?.text === "string" && o.text.trim())
      .slice(0, MAX_OPTIONS)
      .map((o) => ({ text: clean(o.text, 40), confidence: Number.isFinite(o.confidence) ? Math.round(Math.min(1, Math.max(0, o.confidence)) * 100) / 100 : null }));
    return { text, options: options.length ? options : [{ text, confidence: null }] };
  });
}

/** Optional conversation context: {said: last <= 2 sentences the signer's screen spoke, heard: last thing the hearing person said}. */
export function parseContext(body) {
  const c = body?.context;
  if (c == null) return {};
  if (typeof c !== "object" || Array.isArray(c)) throw bad("context must be {said?: string[], heard?: string}");
  const said = (Array.isArray(c.said) ? c.said : []).map((x) => clean(x, 200)).filter(Boolean).slice(-MAX_SAID);
  const heard = clean(c.heard, 300);
  return { ...(said.length ? { said } : {}), ...(heard ? { heard } : {}) };
}

/** The per-request user message (everything that changes; the fixed prefix is instructions + VOCAB_MESSAGE). */
export function composeInput(signs, context = {}) {
  const lines = [];
  if (context.heard || context.said?.length) {
    lines.push("Conversation so far (context only, do not voice it again):");
    if (context.heard) lines.push(`Hearing person just said: "${context.heard}"`);
    for (const s of context.said ?? []) lines.push(`Signer said earlier: "${s}"`);
    lines.push("");
  }
  lines.push(`Signs so far (${signs.length}; picked needs exactly ${signs.length} entries, one per position, in order):`);
  signs.forEach((s, i) => lines.push(`${i + 1}. ${s.options.map((x, j) => `[${j}] ${x.text}${x.confidence == null ? "" : ` ${x.confidence}`}`).join("  ")}`));
  return lines.join("\n");
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

  async function compose(signs, context = {}) {
    const t0 = performance.now();
    const text = composeInput(signs, context);
    const key = createHash("sha256").update(`${model}\n${text}`).digest("hex");
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key); cache.set(key, hit);   // LRU: most recent last
      return { ...hit, cached: true, latency_ms: 0 };
    }
    const p = {
      model, instructions: INSTRUCTIONS, store: false, max_output_tokens: 300, prompt_cache_key: "signlayer-compose-v2",
      input: [
        { role: "developer", content: VOCAB_MESSAGE },
        { role: "user", content: text },
      ],
      text: { format: { type: "json_schema", name: "spoken_sentence", schema: SCHEMA, strict: true } },
    };
    if (/^(gpt-5|o\d)/.test(model)) p.reasoning = { effort: "none" }; else p.temperature = 0;
    const res = await o.client.responses.create(p, { signal: AbortSignal.timeout(timeoutMs), timeout: timeoutMs, maxRetries: 0 });
    const raw = res?.output_text;
    if (!raw) throw Object.assign(new Error("empty response"), { code: "empty_response" });
    const out = JSON.parse(raw);
    const picked = signs.map((s, i) => {
      const v = out.picked?.[i];
      if (v === -1) return -1;
      return Number.isInteger(v) && v >= 0 && v < s.options.length ? v : 0;
    });
    const result = { makes_sense: Boolean(out.makes_sense), sentence: String(out.sentence ?? "").replace(/\s+/g, " ").trim(), picked, model };
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return { ...result, cached: false, latency_ms: Math.round(performance.now() - t0) };
  }

  return { compose, model, timeoutMs };
}
