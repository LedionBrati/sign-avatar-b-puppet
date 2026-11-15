#!/usr/bin/env node
// How much of everyday spoken English can our sign vocab + no-LLM translator cover?
//
//   node translate/coverage.mjs [--top 10000] [--sentences 1500] [--semantic-sample 200]
//                               [--semantic-words 5000] [--seed 42] [--no-semantic] [--threads 1]
//
// Data (free downloads, kept in translate/cache/coverage/, gitignored, never committed):
//   SUBTLEX-US word frequencies (Brysbaert & New 2009; free for research, no open licence stated):
//     curl -L -o subtlexus2.zip https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus/subtlexus2.zip
//     -> SUBTLEXus74286wordstextversion.txt
//   Tatoeba English sentences (CC BY 2.0 FR):
//     curl -L -O https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2 ; bunzip2 it
//     -> eng_sentences.tsv
// Plus translate/coverage-domain.txt (our own ~50 doctor / pharmacy / travel / announcement / small-talk lines).
//
// Rules layer for everything (sync, cheap). Semantic layer (local MiniLM, 1 ONNX thread by default) only on
// samples: the top unsupported words and ~200 sentences. Prints markdown tables; JSON in cache/coverage/results.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { translate, translateRules, toMotionId } from "./index.mjs";
import { DROP, tokenize } from "./rules.mjs";
import { CACHE_DIR, HERE, createNodeMatcher, loadEnglishWords, loadVocab } from "./node.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const num = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const TOP = num("top", 10000), N_SENT = num("sentences", 1500), SEM_SENT = num("semantic-sample", 200);
const SEM_WORDS = num("semantic-words", 5000), SEED = num("seed", 42), THREADS = num("threads", 1);
const DATA = join(CACHE_DIR, "coverage");
const SUBTLEX = join(DATA, "SUBTLEXus74286wordstextversion.txt");
const TATOEBA = join(DATA, "eng_sentences.tsv");
const RECOGNIZER_MAP = process.env.RECOGNIZER_MAP ?? "C:/Users/DELL/AppData/Local/Temp/claude/C--Users-DELL-Desktop-ai-summit/d0736f17-77ac-4311-a8e8-87de17536e75/scratchpad/map.json";
for (const p of [SUBTLEX, TATOEBA]) if (!existsSync(p)) { console.error(`missing ${p}; see the header of coverage.mjs`); process.exit(2); }

const T0 = performance.now();
const out = [];
const log = (s = "") => { out.push(s); console.log(s); };
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : "-");
const results = { params: { TOP, N_SENT, SEM_SENT, SEM_WORDS, SEED, THREADS } };

// ---------- vocabularies ----------
const englishWords = loadEnglishWords();
const dictionary = loadVocab("dictionary");
const clips = loadVocab("clips");
// 250-sign recognizer (sign -> voice): its class names, with aliases for the run-together ones.
const ALIASES = {
  TV: ["tv", "television"], callonphone: ["call", "phone"], frenchfries: ["french fries"],
  glasswindow: ["glass", "window"], haveto: ["have to"], hesheit: ["he", "she", "it"], icecream: ["ice cream"],
  minemy: ["mine", "my"], weus: ["we", "us"], thankyou: ["thank you"], owie: ["ouch", "hurt"], shhh: ["shh"],
  kitty: ["kitty", "cat"], potty: ["potty", "toilet"], grandma: ["grandma", "grandmother"], grandpa: ["grandpa", "grandfather"],
};
let recognizer = [];
if (existsSync(RECOGNIZER_MAP)) {
  for (const k of Object.keys(JSON.parse(readFileSync(RECOGNIZER_MAP, "utf8")))) {
    for (const g of ALIASES[k] ?? [k.toLowerCase()]) recognizer.push({ motion_id: toMotionId(k), gloss: g.toUpperCase() });
  }
}
const VOCABS = { dictionary, clips, ...(recognizer.length ? { recognizer } : {}) };
const nSigns = (v) => new Set(v.map((x) => x.motion_id)).size;
log(`vocab sizes: dictionary ${nSigns(dictionary)}, clips ${nSigns(clips)}, recognizer ${nSigns(recognizer)} signs (${recognizer.length} English aliases)`);

// ---------- SUBTLEX-US ----------
// SUBTLEX splits contractions: don't -> "don" + "t", it's -> "it" + "s". Map the fragments back.
const FRAG = {
  s: "is", t: "not", m: "am", re: "are", ll: "will", ve: "have", d: "would", don: "do", didn: "did", doesn: "does",
  isn: "is", aren: "are", wasn: "was", weren: "were", haven: "have", hasn: "has", hadn: "had", couldn: "could",
  wouldn: "would", shouldn: "should", ain: "is", mustn: "must", needn: "need",
};
const rows = readFileSync(SUBTLEX, "latin1").split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
  const [word, freq, , low] = l.split("\t");
  return { word: word.toLowerCase(), freq: Number(freq), low: Number(low) };
}).filter((r) => /^[a-z]+$/.test(r.word) && r.freq > 0);
const merged = new Map();
for (const r of rows) {
  const m = merged.get(r.word) ?? { word: r.word, freq: 0, low: 0 };
  m.freq += r.freq; m.low += r.low; merged.set(r.word, m);
}
const words = [...merged.values()].sort((a, b) => b.freq - a.freq);
const corpusTokens = words.reduce((s, r) => s + r.freq, 0);
const top = words.slice(0, TOP).map((r) => ({ ...r, as: FRAG[r.word] ?? r.word,
  // Mostly capitalized in subtitles (and not "I") -> a name: fingerspellable.
  name: r.word !== "i" && r.low / r.freq < 0.15 }));
const topTokens = top.reduce((s, r) => s + r.freq, 0);
const subtlexFreq = new Map(words.map((r) => [r.word, r.freq]));
log(`SUBTLEX-US: ${words.length} word types, ${corpusTokens.toLocaleString()} tokens; top ${TOP} = ${pct(topTokens, corpusTokens)}% of tokens`);

/** Rules-only class of one spoken word in isolation. */
function classify(r, vocab) {
  const plan = translateRules(r.as, vocab, { englishWords });
  if (plan.dropped_tokens.length && !plan.items.length && !plan.unsupported_tokens.length) return "dropped";
  const it = plan.items[0];
  if (it?.type === "sign") return it.match.method;                 // exact | phrase | lemma | synonym
  if (r.name) return "name";
  if (it?.type === "fingerspell") return "fs_nonword";            // not in the 275k word list ("gonna", "uh-huh")
  return "unsupported";
}
const CLASSES = ["exact", "phrase", "lemma", "synonym", "semantic", "dropped", "name", "fs_nonword", "unsupported"];
const BANDS = [100, 1000, 5000, TOP].filter((b, i, a) => b <= TOP && a.indexOf(b) === i);

function tokenCoverage(vocab) {
  const cls = top.map((r) => classify(r, vocab));
  const byBand = BANDS.map((b) => {
    const w = Object.fromEntries(CLASSES.map((c) => [c, 0]));
    let tot = 0;
    for (let i = 0; i < b; i++) { w[cls[i]] += top[i].freq; tot += top[i].freq; }
    const signed = w.exact + w.phrase + w.lemma + w.synonym;
    return { band: b, tot, w, signed, covered: signed + w.dropped + w.name + w.fs_nonword };
  });
  return { cls, byBand };
}

log("\n## Token coverage, frequency-weighted (rules only; each word looked up alone)");
const tok = {};
for (const [name, vocab] of Object.entries(VOCABS)) tok[name] = tokenCoverage(vocab);
log(`\n| vocab | band | signed | dropped (ASL omits) | fingerspell name | fingerspell non-word | covered total | unsupported |`);
log(`|---|---|---|---|---|---|---|---|`);
for (const [name, t] of Object.entries(tok)) for (const b of t.byBand) {
  log(`| ${name} | top ${b.band} | ${pct(b.signed, b.tot)}% | ${pct(b.w.dropped, b.tot)}% | ${pct(b.w.name, b.tot)}% | ${pct(b.w.fs_nonword, b.tot)}% | ${pct(b.covered, b.tot)}% | ${pct(b.w.unsupported, b.tot)}% |`);
}
const dictTop = tok.dictionary.byBand.at(-1);
log(`\ndictionary, top ${TOP}, signed by method: ` + ["exact", "phrase", "lemma", "synonym"].map((m) => `${m} ${pct(dictTop.w[m], dictTop.tot)}%`).join(", "));
log(`types in top ${TOP} by class (dictionary): ` + CLASSES.map((c) => `${c} ${tok.dictionary.cls.filter((x) => x === c).length}`).join(", "));
results.token = Object.fromEntries(Object.entries(tok).map(([k, t]) => [k, t.byBand]));

// ---------- semantic layer (local MiniLM), one ONNX thread so the busy laptop is not swamped ----------
let matcher = null;
if (!flag("no-semantic")) {
  const importer = async () => {
    const t = await import("@huggingface/transformers");
    return { env: t.env, pipeline: (task, model, o) => t.pipeline(task, model,
      { ...o, session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 } }) };
  };
  matcher = createNodeMatcher({ allowRemote: false, importer });
}

const semWords = [];
if (matcher) {
  log(`\n## Semantic layer on unsupported words (dictionary vocab, top ${SEM_WORDS} words)`);
  const t0 = performance.now();
  const cand = top.slice(0, SEM_WORDS).map((r, i) => ({ r, c: tok.dictionary.cls[i] })).filter((x) => x.c === "unsupported");
  for (const { r } of cand) {
    const plan = await translate(r.as, dictionary, { matcher, englishWords });
    const it = plan.items[0];
    if (it?.type === "sign" && it.match.method === "semantic") semWords.push({ word: r.word, freq: r.freq, gloss: it.gloss, score: it.match.score });
  }
  const tot5 = top.slice(0, SEM_WORDS).reduce((s, r) => s + r.freq, 0);
  const semW = semWords.reduce((s, x) => s + x.freq, 0);
  const b5 = tok.dictionary.byBand.find((b) => b.band === SEM_WORDS) ?? null;
  log(`${cand.length} unsupported words tried, ${semWords.length} accepted at >= 0.70 (${pct(semW, tot5)}% of top-${SEM_WORDS} tokens) in ${Math.round(performance.now() - t0)} ms`);
  if (b5) log(`top ${SEM_WORDS}: signed rules ${pct(b5.signed, b5.tot)}% -> rules+semantic ${pct(b5.signed + semW, b5.tot)}%; unsupported ${pct(b5.w.unsupported, b5.tot)}% -> ${pct(b5.w.unsupported - semW, b5.tot)}%`);
  log(`most frequent semantic matches (NOT checked for correctness): ` + semWords.slice(0, 40).map((x) => `${x.word}->${x.gloss} ${x.score}`).join(", "));
  results.semanticWords = { tried: cand.length, accepted: semWords.length, weightedPct: Number(pct(semW, tot5)), list: semWords };
}

// ---------- sentences ----------
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = mulberry32(SEED);
const seen = new Set();
const pool = [];
for (const line of readFileSync(TATOEBA, "utf8").split("\n")) {
  const [id, , text] = line.split("\t");
  if (!text) continue;
  const s = text.trim();
  const n = s.split(/\s+/).length;
  // Short, plain, everyday-looking: 3-10 words, ASCII letters and simple punctuation, ends in . ? !
  if (n < 3 || n > 10 || !/^[A-Z][A-Za-z ,'?!.-]*[.?!]$/.test(s)) continue;
  // Tatoeba's house characters Tom and Mary are in ~1/4 of sentences; sentence-initial "Tom" is in the
  // English word list (tom = male cat), so it would dominate the missing-word list. Leave them out.
  if (/\b(Tom|Mary)\b/.test(s)) continue;
  const key = s.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key); pool.push({ id: Number(id), text: s });
}
for (let i = 0; i < Math.min(N_SENT, pool.length); i++) {   // partial Fisher-Yates, seeded
  const j = i + Math.floor(rand() * (pool.length - i));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const tatoeba = pool.slice(0, N_SENT).map((x) => ({ ...x, set: "tatoeba" }));
const domain = readFileSync(join(HERE, "coverage-domain.txt"), "utf8").split(/\r?\n/)
  .filter((l) => l && !l.startsWith("#")).map((l) => { const [cat, text] = l.split("\t"); return { set: "domain", cat, text }; });
log(`\nsentences: Tatoeba pool ${pool.length} (3-10 words, no Tom/Mary), sampled ${tatoeba.length} (seed ${SEED}); domain ${domain.length}`);
results.tatoebaIds = tatoeba.map((x) => x.id);

// Function words: not counted as "content" (ASL drops most; English needs them, signs do not).
const FUNCTION = new Set([...DROP, "and", "or", "but", "if", "so", "than", "then", "as", "for", "with", "from", "by",
  "in", "on", "into", "onto", "about", "will", "would", "shall", "should", "could", "can", "may", "might", "must",
  "just", "very", "really", "too", "also", "that", "there", "has", "had"]);

function sentenceStats(text, plan) {
  const toks = tokenize(text).map((t) => t.w);
  const content = toks.filter((w) => !FUNCTION.has(w));
  const uns = plan.unsupported_tokens.map((w) => w.toLowerCase());
  const unsContent = uns.filter((w) => !FUNCTION.has(w));
  return { content: content.length, unsContent, uns, strict: uns.length === 0, full: unsContent.length === 0,
    pctSigned: content.length ? (content.length - unsContent.length) / content.length : 1,
    fs: plan.items.filter((i) => i.type === "fingerspell").length,
    semantic: plan.items.filter((i) => i.match?.method === "semantic").length };
}
const summarize = (stats) => ({
  n: stats.length,
  full: stats.filter((s) => s.full).length,
  strict: stats.filter((s) => s.strict).length,
  avgSigned: stats.reduce((a, s) => a + s.pctSigned, 0) / (stats.length || 1),
  withFs: stats.filter((s) => s.fs).length,
  withSem: stats.filter((s) => s.semantic).length,
});
const rulesStats = (set, vocab) => set.map((s) => sentenceStats(s.text, translateRules(s.text, vocab, { englishWords })));

log("\n## Sentence coverage, rules only");
log(`\n| vocab | set | n | fully signable (no unsupported content word) | no unsupported token at all | avg % content words signed | with fingerspelling |`);
log(`|---|---|---|---|---|---|---|`);
results.sentences = {};
for (const [name, vocab] of Object.entries(VOCABS)) for (const [setName, set] of [["tatoeba", tatoeba], ["domain", domain]]) {
  const sm = summarize(rulesStats(set, vocab));
  results.sentences[`${name}/${setName}`] = sm;
  log(`| ${name} | ${setName} | ${sm.n} | ${pct(sm.full, sm.n)}% | ${pct(sm.strict, sm.n)}% | ${(100 * sm.avgSigned).toFixed(1)}% | ${pct(sm.withFs, sm.n)}% |`);
}

// Rules vs rules+semantic on a subsample (dictionary vocab).
const semPlans = new Map();
if (matcher) {
  const sub = tatoeba.slice(0, SEM_SENT);
  log(`\n## Sentence coverage, rules vs rules+semantic (dictionary vocab; Tatoeba first ${sub.length} of the sample + all domain)`);
  log(`\n| set | layers | n | fully signable | avg % content words signed | sentences using a semantic match |`);
  log(`|---|---|---|---|---|---|`);
  const t0 = performance.now();
  for (const [setName, set] of [["tatoeba", sub], ["domain", domain]]) {
    const r = summarize(rulesStats(set, dictionary));
    const semStats = [];
    for (const s of set) {
      const plan = await translate(s.text, dictionary, { matcher, englishWords });
      semPlans.set(s.text, plan);
      semStats.push(sentenceStats(s.text, plan));
    }
    const m = summarize(semStats);
    results.sentences[`semantic/${setName}`] = { rules: r, semantic: m };
    log(`| ${setName} | rules | ${r.n} | ${pct(r.full, r.n)}% | ${(100 * r.avgSigned).toFixed(1)}% | - |`);
    log(`| ${setName} | rules+semantic | ${m.n} | ${pct(m.full, m.n)}% | ${(100 * m.avgSigned).toFixed(1)}% | ${pct(m.withSem, m.n)}% |`);
  }
  log(`(semantic sentence pass: ${Math.round(performance.now() - t0)} ms)`);
}

// ---------- shopping list: most frequent unsupported words (dictionary vocab, rules) ----------
const allSent = [...tatoeba, ...domain];
const dictSentStats = rulesStats(allSent, dictionary);
const sentCount = new Map();
for (const s of dictSentStats) for (const w of new Set(s.unsContent)) sentCount.set(w, (sentCount.get(w) ?? 0) + 1);
const missing = [];
const seenMissing = new Set();
top.forEach((r, i) => {
  if (tok.dictionary.cls[i] !== "unsupported" || seenMissing.has(r.as)) return;
  seenMissing.add(r.as);
  missing.push({ word: r.as, freq: r.freq, perMillion: (1e6 * r.freq / corpusTokens), sentences: sentCount.get(r.as) ?? 0,
    semantic: semWords.find((x) => x.word === r.word)?.gloss });
});
log(`\n## Top 50 missing words (dictionary vocab, rules; ranked by SUBTLEX-US frequency)`);
log(`\n| # | word | per million spoken words | Tatoeba+domain sentences blocked | semantic would map to |`);
log(`|---|---|---|---|---|`);
missing.slice(0, 50).forEach((m, i) => log(`| ${i + 1} | ${m.word} | ${m.perMillion.toFixed(0)} | ${m.sentences} | ${m.semantic ?? ""} |`));
const bySent = [...sentCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
log(`\nmost frequent unsupported content words in the sentence sets: ` + bySent.map(([w, c]) => `${w} ${c}`).join(", "));
results.missing = missing.slice(0, 1000);

// ---------- what-if: add the N most frequent missing words as signs ----------
log(`\n## What-if: add the N most frequent missing words as new signs (dictionary vocab, rules)`);
log(`\n| added signs | vocab | token coverage top ${TOP} (signed+dropped+fingerspell) | signed only | Tatoeba fully signable | domain fully signable | avg % content signed (Tatoeba) |`);
log(`|---|---|---|---|---|---|---|`);
results.whatIf = [];
for (const N of [0, 100, 250, 500, 1000]) {
  const extra = missing.slice(0, N).map((m) => ({ motion_id: toMotionId(m.word), gloss: m.word.toUpperCase() }));
  const vocab = [...dictionary, ...extra];
  const t = N ? tokenCoverage(vocab).byBand.at(-1) : dictTop;
  const ts = summarize(rulesStats(tatoeba, vocab)), ds = summarize(rulesStats(domain, vocab));
  results.whatIf.push({ N, token: t.covered / t.tot, signed: t.signed / t.tot, tatoeba: ts, domain: ds });
  log(`| +${N} | ${nSigns(dictionary) + N} | ${pct(t.covered, t.tot)}% | ${pct(t.signed, t.tot)}% | ${pct(ts.full, ts.n)}% | ${pct(ds.full, ds.n)}% | ${(100 * ts.avgSigned).toFixed(1)}% |`);
}

// ---------- examples ----------
const EXAMPLES = [
  "Where does it hurt?", "I have a headache and a fever.", "Take one pill twice a day after food.",
  "Where is the nearest pharmacy?", "What time does the bus leave?", "Turn left at the corner.",
  "Please turn off your phone.", "The school is closed because of snow.", "Hello, my name is Maria.",
  "I don't understand, please repeat.", "Do you have a prescription?", "My flight is delayed.",
  ...tatoeba.slice(0, 3).map((x) => x.text),
];
const show = (plan) => {
  const items = plan.items.map((it) => it.type === "fingerspell" ? `fs:${it.word}`
    : it.gloss.replace(/ /g, "_") + (["exact", "phrase"].includes(it.match.method) ? "" : `(${it.match.method}${it.match.score !== undefined ? " " + it.match.score : ""})`));
  const mk = plan.nonmanual_markers.map((m) => `${m.type}[${m.from}-${m.to}]`).join(" ");
  return `${items.join(" ") || "(nothing)"}${mk ? "  {" + mk + "}" : ""}${plan.unsupported_tokens.length ? "  MISSING: " + plan.unsupported_tokens.join(", ") : ""}`;
};
log(`\n## Examples (dictionary vocab, ${matcher ? "rules+semantic" : "rules"})`);
log(`\n| sentence | plan |`);
log(`|---|---|`);
for (const s of EXAMPLES) {
  const plan = semPlans.get(s) ?? (matcher ? await translate(s, dictionary, { matcher, englishWords }) : translateRules(s, dictionary, { englishWords }));
  log(`| ${s} | ${show(plan)} |`);
}
log(`\ntotal runtime ${Math.round((performance.now() - T0) / 1000)} s`);
writeFileSync(join(DATA, "results.json"), JSON.stringify(results, null, 1));
