// English -> ASL sign plan (README §6.5), no remote model or API calls.
//
//   import { translate, translateRules } from "./translate/index.mjs";
//   const plan = await translate("Where does it hurt?", vocab);      // rules + local embeddings
//   const plan = translateRules("Where does it hurt?", vocab);       // rules only, sync, < 1 ms
//
// vocab = [{ motion_id: "THANK_YOU", gloss: "THANK YOU" }, ...]: the signs available right now.
// Output passes shared/contracts.mjs assertPlan() whenever plan.ok is true (at least one item).
// Every sign item's motion_id comes from vocab; nothing is invented. Words we cannot map are
// fingerspelled (names) or listed in unsupported_tokens. Order and markers are APPROXIMATE
// (signed English with a few ASL-ish rules), not ASL grammar; no fluent signer has reviewed them.

import {
  DROP, TIME, TIME_MODIFIERS, TIME_UNITS, WH, NEGATION, NEGATION_WORDS, NO_SEMANTIC, SYNONYMS,
  lemmaCandidates, tokenize, glossKey, splitSentences, toFingerspell, isNameCue,
} from "./rules.mjs";
import { SemanticMatcher, DEFAULT_THRESHOLD } from "./semantic.mjs";

export { toMotionId, glossKey } from "./rules.mjs";
export { SemanticMatcher, DEFAULT_THRESHOLD, DEFAULT_MODEL } from "./semantic.mjs";

const CANONICAL = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const indexCache = new WeakMap();

/** Index vocab by normalized gloss key. Invalid entries (bad motion_id, no gloss) are skipped. */
export function indexVocab(vocab) {
  if (!Array.isArray(vocab)) throw new TypeError("vocab must be an array of {motion_id, gloss}");
  if (indexCache.has(vocab)) return indexCache.get(vocab);
  const byKey = new Map();
  const words = new Set();
  let maxLen = 1;
  for (const v of vocab) {
    if (!v || typeof v.gloss !== "string" || !CANONICAL.test(v.motion_id ?? "")) continue;
    const key = glossKey(v.gloss);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, v);
    const parts = key.split(" ");
    maxLen = Math.max(maxLen, parts.length);
    parts.forEach((p) => words.add(p));
  }
  const index = { byKey, words, maxLen, keys: [...byKey.keys()] };
  // Targets the semantic layer may pick: not question words or negations (they would change sentence type).
  index.semanticKeys = index.keys.filter((k) => !WH.has(k) && !NEGATION.has(k));
  indexCache.set(vocab, index);
  return index;
}

const synonymFor = (index, phrase) => {
  for (const target of SYNONYMS[phrase] ?? []) {
    const e = index.byKey.get(target);
    if (e) return e;
  }
  return null;
};

const bestLemma = (index, w) => lemmaCandidates(w).find((c) => index.words.has(c)) ?? w;

const isEnglish = (englishWords, w) => {
  if (!englishWords) return true;                 // no word list: only capitalization marks names
  if (typeof englishWords === "function") return englishWords(w);
  return englishWords.has(w);
};

/** Layer 1: map the words of one sentence to units (sign / drop / fingerspell / leftover). */
function matchSentence(sentence, index, options) {
  const toks = tokenize(sentence.text);
  toks.forEach((t, i) => {
    t.first = i === 0;
    t.nameCue = t.cap && t.w !== "i" && i >= 1 && isNameCue(toks[i - 2]?.w, toks[i - 1].w);
  });
  const units = [];
  const sign = (entry, method, tokens, extra = {}) =>
    units.push({ kind: "sign", entry, method, source: tokens.map((t) => t.orig).join(" "), tokens, ...extra });
  for (let i = 0; i < toks.length;) {
    const t = toks[i];
    if (t.nameCue) { units.push({ kind: "leftover", token: t, reason: "name" }); i++; continue; }
    let done = false;
    // Longest phrase first ("thank you", "see you later", "a lot", "don't want" = "do not want").
    for (let n = Math.min(index.maxLen, toks.length - i, 4); n >= 2 && !done; n--) {
      const win = toks.slice(i, i + n);
      if (win.some((x) => x.nameCue)) continue;
      const surface = win.map((x) => x.w).join(" ");
      let e = index.byKey.get(surface), method = "phrase";
      if (!e) {
        const lem = win.map((x) => bestLemma(index, x.w)).join(" ");
        if (lem !== surface) e = index.byKey.get(lem);
      }
      if (!e && (e = synonymFor(index, surface))) method = "synonym";
      if (e) { sign(e, method, win); i += n; done = true; }
    }
    if (done) continue;
    const w = t.w;
    i++;
    if (DROP.has(w)) { units.push({ kind: "drop", token: t }); continue; }
    let e = index.byKey.get(w);
    if (e) { sign(e, "exact", [t]); continue; }
    if ((e = synonymFor(index, w))) { sign(e, "synonym", [t]); continue; }
    let lemmaUnit = null;
    for (const c of lemmaCandidates(w)) {
      if (DROP.has(c)) { lemmaUnit = { kind: "drop", token: t }; break; }
      if ((e = index.byKey.get(c))) { lemmaUnit = { e, method: "lemma", lemma: c }; break; }
      if ((e = synonymFor(index, c))) { lemmaUnit = { e, method: "synonym", lemma: c }; break; }
    }
    if (lemmaUnit?.kind === "drop") { units.push(lemmaUnit); continue; }
    if (lemmaUnit) { sign(lemmaUnit.e, lemmaUnit.method, [t], { lemma: lemmaUnit.lemma }); continue; }
    // Leftover: name -> fingerspell, English content word -> semantic layer, else unsupported.
    const midCap = t.cap && !t.first && w !== "i";
    let reason;
    if (/^\d+$/.test(w)) reason = "unsupported";
    else if (midCap) reason = "name";
    else if (/^[a-z]+$/.test(w) && !isEnglish(options.englishWords, w)) reason = "not_english";
    else if (NO_SEMANTIC.has(w) || NEGATION_WORDS.has(w) || WH.has(w)) reason = "unsupported";
    else reason = "semantic_candidate";
    units.push({ kind: "leftover", token: t, reason });
  }
  return { ...sentence, toks, units };
}

/** Layer 4: turn leftovers into fingerspelling or unsupported tokens (after semantic had its chance). */
function resolveLeftover(u, semanticHit, threshold) {
  const t = u.token;
  if (u.reason === "name" || u.reason === "not_english") {
    const word = toFingerspell(t.orig);
    if (word) return { kind: "fingerspell", word, source: t.orig, source_index: t.wi, reason: u.reason === "name" ? "capitalized_name" : "not_in_word_list" };
    return { kind: "unsupported", token: t.orig };
  }
  if (u.reason === "semantic_candidate" && semanticHit && semanticHit.score >= threshold) {
    return { kind: "sign", entry: semanticHit.entry, method: "semantic", score: semanticHit.score,
      source: t.orig, source_index: t.wi, alternatives: semanticHit.alternatives };
  }
  return { kind: "unsupported", token: t.orig, best: semanticHit ? { gloss: semanticHit.entry.gloss, score: semanticHit.score } : undefined };
}

const keyOf = (item) => item.type === "sign" ? glossKey(item.gloss) : null;

/** Layer 2: ASL-ish order and nonmanual markers for one sentence (approximate, see README). */
function orderSentence(s, items) {
  // Time words to the front (with a NEXT/LAST/THIS modifier right before them).
  const groups = [];
  for (let i = 0; i < items.length; i++) {
    const k = keyOf(items[i]);
    const withModifier = i > 0 && TIME_MODIFIERS.has(keyOf(items[i - 1]));
    if (k && (TIME.has(k) || (TIME_UNITS.has(k) && withModifier))) {
      const start = i > 0 && TIME_MODIFIERS.has(keyOf(items[i - 1])) && !groups.some((g) => g.includes(i - 1)) ? i - 1 : i;
      groups.push(Array.from({ length: i - start + 1 }, (_, j) => start + j));
    }
  }
  const timeIdx = new Set(groups.flat());
  if (timeIdx.size && timeIdx.size < items.length) {
    items = [...items.filter((_, i) => timeIdx.has(i)), ...items.filter((_, i) => !timeIdx.has(i))];
  }
  const markers = [];
  const hasWhWord = s.toks.some((t) => WH.has(t.w));
  const whFirst = s.toks.length > 0 && WH.has(s.toks[0].w);
  // "Where is it" without punctuation counts; "When I was young, ..." ending in "." does not.
  const whQuestion = hasWhWord && (s.question || (whFirst && !s.statement));
  if (whQuestion) {
    const isWh = (it) => WH.has(keyOf(it));
    if (items.some(isWh) && items.some((it) => !isWh(it))) items = [...items.filter((it) => !isWh(it)), ...items.filter(isWh)];
    if (items.length) markers.push({ type: "question_wh", from: 0, to: items.length - 1 });
  } else if (s.question && items.length) {
    markers.push({ type: "question_yn", from: 0, to: items.length - 1 });
  }
  const neg = items.findIndex((it) => NEGATION.has(keyOf(it)));
  if (neg >= 0) markers.push({ type: "negation", from: neg, to: items.length - 1 });
  return { items, markers };
}

function buildPlan(text, sentences, semanticHits, opts, timings, warnings) {
  const items = [], markers = [], unsupported = [], dropped = [], nearMisses = [];
  for (const s of sentences) {
    const local = [];
    for (const u of s.units) {
      let r = u;
      if (u.kind === "leftover") r = resolveLeftover(u, semanticHits.get(u.token.w), opts.threshold);
      if (r.kind === "drop") dropped.push(r.token.orig);
      else if (r.kind === "unsupported") {
        unsupported.push(r.token);
        if (r.best) nearMisses.push({ token: r.token, gloss: r.best.gloss, score: r.best.score });
      }
      else if (r.kind === "fingerspell") {
        local.push({ type: "fingerspell", word: r.word, source: r.source, source_index: r.source_index, match: { method: "fingerspell", reason: r.reason } });
      } else if (r.kind === "sign") {
        const match = { method: r.method };
        if (r.score !== undefined) match.score = r.score;
        if (r.lemma) match.lemma = r.lemma;
        if (r.alternatives) match.alternatives = r.alternatives.map((a) => ({ gloss: a.gloss, score: a.score }));
        local.push({ type: "sign", gloss: r.entry.gloss, motion_id: r.entry.motion_id, source: r.source, source_index: r.source_index ?? r.tokens?.[0]?.wi, match });
      }
    }
    const { items: ordered, markers: m } = orderSentence(s, local);
    const off = items.length;
    items.push(...ordered);
    markers.push(...m.map((x) => ({ ...x, from: x.from + off, to: x.to + off })));
  }
  if (!items.length) warnings.push("nothing in this text maps to an available sign or fingerspelling; plan.ok is false and assertPlan() would reject it");
  return {
    input_text: text,
    items,
    nonmanual_markers: markers,
    unsupported_tokens: unsupported,
    caption: text,
    ok: items.length > 0,
    dropped_tokens: dropped,
    // Best semantic candidate for unsupported words that scored below the threshold (for tuning; not signed).
    near_misses: nearMisses,
    warnings,
    timings,
    translator: {
      name: "translate/rules+local-embeddings",
      approximate: "signed-English word lookup with simple ASL-ish ordering; not ASL grammar; not signer-reviewed",
      semantic: opts.semanticUsed ? { model: opts.model, threshold: opts.threshold } : false,
    },
  };
}

function prepare(text, vocab, options) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  const index = indexVocab(vocab);
  const t0 = performance.now();
  const input = text.trim().replace(/\s+/g, " ");
  const sentences = splitSentences(input).map((s) => matchSentence(s, index, options));
  // source_index: index of each token's word in input_text.split(" ") (for captions, "signing X for 'word'").
  let cursor = 0;
  for (const s of sentences) {
    const at = input.indexOf(s.text, cursor);
    const base = at >= 0 ? at : cursor;
    cursor = base + s.text.length;
    for (const t of s.toks) {
      const off = base + t.start;
      let wi = 0;
      for (let k = 0; k < off; k++) if (input[k] === " ") wi++;
      t.wi = wi;
    }
  }
  return { input, index, sentences, rules_ms: performance.now() - t0 };
}

const ms = (x) => Math.round(x * 1000) / 1000;

/** Rules only, synchronous. Leftover English words become unsupported_tokens. */
export function translateRules(text, vocab, options = {}) {
  const { input, sentences, rules_ms } = prepare(text, vocab, options);
  const t1 = performance.now();
  const plan = buildPlan(input, sentences, new Map(), { threshold: Infinity, semanticUsed: false }, {}, []);
  plan.timings = { rules_ms: ms(rules_ms + performance.now() - t1), semantic_ms: 0, model_load_ms: 0 };
  return plan;
}

let defaultMatcher = null;

/**
 * Full translator: rules, then local semantic matching for leftover content words.
 * options.semantic: false to skip layer 3; options.matcher: a SemanticMatcher (shared across calls);
 * options.threshold: override; options.englishWords: Set or (word) => boolean used to spot names.
 * Never throws because of the model: if it cannot load, the plan is rules-only with a warning.
 */
export async function translate(text, vocab, options = {}) {
  const { input, index, sentences, rules_ms } = prepare(text, vocab, options);
  const warnings = [];
  const timings = { rules_ms: 0, semantic_ms: 0, model_load_ms: 0 };
  const hits = new Map();
  let semanticUsed = false;
  let matcher = null;
  const queries = [...new Set(sentences.flatMap((s) => s.units)
    .filter((u) => u.kind === "leftover" && u.reason === "semantic_candidate").map((u) => u.token.w))];
  if (options.semantic !== false && queries.length) {
    matcher = options.matcher ?? (defaultMatcher ??= new SemanticMatcher());
    const wasLoaded = Boolean(matcher.extractor);
    const t0 = performance.now();
    try {
      if (await matcher.load()) {
        if (!wasLoaded) timings.model_load_ms = matcher.stats.model_load_ms;
        const t1 = performance.now();
        const res = await matcher.nearest(queries, index.semanticKeys);
        for (const r of res) {
          // Guard: subword models rate "wrist" ~ "wristwatch", "flat" ~ "flatter" highly. A gloss that is the
          // query plus extra letters is a different word, so skip it and take the next candidate.
          // Same for compounds that merely contain the word: "turn" ~ "take turns", "peanuts" ~ "peanut butter".
          const stem = r.query.slice(0, 4);
          const ranked = [{ key: r.key, score: r.score }, ...r.alternatives]
            .filter((c) => !(c.key.startsWith(r.query) && c.key.length > r.query.length + 1))
            .filter((c) => !(c.key.includes(" ") && c.key.split(" ").some((w) => w.startsWith(stem))));
          if (!ranked.length) continue;
          const [best, ...rest] = ranked;
          hits.set(r.query, { entry: index.byKey.get(best.key), score: best.score,
            alternatives: rest.map((a) => ({ gloss: index.byKey.get(a.key).gloss, score: a.score })) });
        }
        timings.semantic_ms = ms(performance.now() - t1);
        timings.vocab_embed_ms = matcher.stats.vocab_embed_ms;
        timings.vocab_cache = matcher.stats.vocab_cache;
        semanticUsed = true;
      } else {
        warnings.push(`semantic layer unavailable (${matcher.failed}); rules only`);
      }
    } catch (error) {
      warnings.push(`semantic layer failed (${error instanceof Error ? error.message : String(error)}); rules only`);
    }
    if (!semanticUsed) timings.model_load_ms = ms(performance.now() - t0);
  }
  const threshold = options.threshold ?? matcher?.threshold ?? DEFAULT_THRESHOLD;
  const t2 = performance.now();
  const plan = buildPlan(input, sentences, hits,
    { threshold, semanticUsed, model: matcher?.model }, timings, warnings);
  timings.rules_ms = ms(rules_ms + performance.now() - t2);
  return plan;
}
