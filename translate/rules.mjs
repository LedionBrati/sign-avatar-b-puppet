// Rule tables and text helpers for the English -> sign-plan translator.
// Plain ESM, no Node or browser APIs, so it runs anywhere.
//
// Everything here is an APPROXIMATION. Word lookup plus a few reordering rules
// is signed English with ASL-ish word order, not ASL grammar (README §6.5).
// Every list is short on purpose; extend it deliberately, not by guessing.

/** Words ASL usually does not sign as separate signs. Dropped (reported in plan.dropped_tokens). */
export const DROP = new Set([
  "a", "an", "the",                                   // articles: ASL has none
  "am", "is", "are", "was", "were", "be", "been", "being", // copula: ASL has no "to be"
  "do", "does", "did",                                // auxiliaries ("where does it hurt")
  "to",                                               // infinitive / "go to school" -> GO SCHOOL
  "of", "at",                                         // usually carried by the sign or by space
  "it",                                               // ASL points (IX) instead; we have no IX sign yet
  "um", "uh", "er", "erm", "hmm",                     // fillers
]);

/** Time words moved to the front of their sentence (TIME-COMMENT order). "later" is left in place on purpose. */
export const TIME = new Set([
  "today", "tomorrow", "yesterday", "now", "tonight",
  "morning", "afternoon", "evening", "night", "noon", "midnight", "weekend",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "last week", "last year", "every monday", "every tuesday", "all day", "from now on",
]);
/** A modifier right before a time word travels with it ("next week" -> NEXT WEEK at the front). */
export const TIME_MODIFIERS = new Set(["next", "last", "this", "every", "early", "good"]); // "good" keeps GOOD MORNING together
/** Moved only together with a modifier: "next week", "every day", "last month". */
export const TIME_UNITS = new Set(["day", "week", "month", "year"]);

export const WH = new Set(["where", "what", "who", "when", "why", "how", "which"]);

/** Glosses that negate. They get a {type:"negation"} span from the sign to the end of the sentence. */
export const NEGATION = new Set(["not", "never", "do not want", "do not know", "do not like", "not yet", "can not"]);
/** English words that negate; if no NEGATION gloss exists in the vocab they stay in unsupported_tokens. */
export const NEGATION_WORDS = new Set(["not", "never"]);

/** Function words we never send to the semantic layer: if not an exact vocab gloss they are unsupported. */
export const NO_SEMANTIC = new Set([
  "and", "or", "but", "if", "so", "for", "with", "from", "by", "in", "on", "into", "onto", "about", "as",
  "than", "then", "there", "here", "this", "that", "these", "those", "very", "really", "just", "also", "too",
  "will", "would", "could", "should", "can", "may", "might", "must", "shall", "has", "have", "had",
  "i", "me", "my", "you", "your", "he", "him", "his", "she", "her", "we", "us", "our", "they", "them", "their",
  "its", "mine", "yours", "not", "no", "yes", "up", "down", "out", "off", "over", "much", "many", "some", "any",
]);

/**
 * Curated synonyms: English word or phrase -> candidate glosses, first one present in the vocab wins.
 * Only maps to glosses that exist in the vocab passed to translate(); never invents a sign.
 */
export const SYNONYMS = {
  hi: ["hello"], hey: ["hello"], hiya: ["hello"], howdy: ["hello"], greetings: ["hello"],
  bye: ["goodbye", "bye"], goodbye: ["goodbye", "bye"],
  thanks: ["thank you"], thx: ["thank you"], "thank u": ["thank you"],
  "see ya": ["see you later"],
  physician: ["doctor"], doc: ["doctor"], gp: ["doctor"], dr: ["doctor"],
  unwell: ["sick"], ill: ["sick"], poorly: ["sick"],
  ache: ["pain", "hurt"], painful: ["pain", "hurt"], sore: ["pain", "hurt"],
  mom: ["mother"], mum: ["mother"], mommy: ["mother"], mama: ["mother"],
  dad: ["father"], daddy: ["father"], papa: ["father"],
  kid: ["child"], kiddo: ["child"], infant: ["baby"],
  belly: ["stomach"], tummy: ["stomach"],
  pill: ["medicine", "pill"], meds: ["medicine"], medication: ["medicine"], tablet: ["medicine"],
  restroom: ["bathroom", "toilet"], washroom: ["bathroom", "toilet"], loo: ["bathroom", "toilet"], lavatory: ["bathroom", "toilet"],
  automobile: ["car"], vehicle: ["car"],
  okay: ["fine"], ok: ["fine"], alright: ["fine"],
  yeah: ["yes"], yep: ["yes"], yup: ["yes"], nope: ["no"], nah: ["no"],
  huge: ["big"], large: ["big"], tiny: ["small"],
  glad: ["happy"], unhappy: ["sad"], mad: ["angry"],
  purchase: ["buy"], begin: ["start"], assist: ["help"],
  telephone: ["phone"], cellphone: ["phone"], mobile: ["phone"],
  "throw up": ["vomit"], puke: ["vomit"],
  "right now": ["now"],                                           // not RIGHT (direction/correct) + NOW
  "have to": ["must", "need"], "has to": ["must", "need"], "had to": ["must", "need"],
  fever: ["fever", "temperature"],
};

/** Irregular forms -> base. Only used when the surface word itself is not a gloss. */
export const IRREGULAR = {
  has: "have", had: "have", having: "have",
  went: "go", gone: "go", goes: "go",
  saw: "see", seen: "see",
  ate: "eat", eaten: "eat",
  came: "come", got: "get", gotten: "get", gave: "give", given: "give",
  took: "take", taken: "take", made: "make", knew: "know", known: "know",
  thought: "think", felt: "feel", told: "tell", said: "say", bought: "buy", brought: "bring",
  taught: "teach", caught: "catch", fought: "fight", found: "find", left: "leave", lost: "lose",
  met: "meet", paid: "pay", ran: "run", sat: "sit", slept: "sleep", spoke: "speak", spoken: "speak",
  spent: "spend", stood: "stand", understood: "understand", wrote: "write", written: "write",
  drank: "drink", drunk: "drink", drove: "drive", driven: "drive", fell: "fall", fallen: "fall",
  forgot: "forget", forgotten: "forget", began: "begin", begun: "begin", broke: "break", broken: "break",
  chose: "choose", chosen: "choose", wore: "wear", won: "win", heard: "hear", held: "hold", kept: "keep",
  built: "build", sent: "send", sold: "sell", swam: "swim", threw: "throw", thrown: "throw",
  woke: "wake", woken: "wake", grew: "grow", grown: "grow", flew: "fly", flown: "fly", drew: "draw",
  children: "child", men: "man", women: "woman", people: "person", feet: "foot", teeth: "tooth",
  mice: "mouse", geese: "goose",
  better: "good", best: "good", worse: "bad", worst: "bad",
};

/** Words ending in -s that are not plurals. */
const NO_STRIP = new Set(["news", "always", "perhaps", "series", "species", "thus", "yes", "this", "his", "has",
  "was", "does", "gas", "bus", "plus", "lens", "physics", "maths", "mathematics", "glasses", "pants", "jeans",
  "scissors", "its", "us", "christmas", "diabetes", "measles", "mumps"]);

const doubled = (b) => b.length >= 3 && b[b.length - 1] === b[b.length - 2] && !/[aeiouy]/.test(b[b.length - 1]);

/** Candidate base forms, most likely first. The caller accepts only candidates present in the vocab. */
export function lemmaCandidates(w) {
  const out = [];
  if (IRREGULAR[w]) out.push(IRREGULAR[w]);
  if (!NO_STRIP.has(w)) {
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) out.push(w.slice(0, -1));
    if (w.length > 4 && w.endsWith("ies")) out.push(w.slice(0, -3) + "y");
    if (w.length > 4 && w.endsWith("ves")) out.push(w.slice(0, -3) + "f", w.slice(0, -3) + "fe");
    if (w.length > 3 && w.endsWith("es")) out.push(w.slice(0, -2));
  }
  if (w.length >= 5 && w.endsWith("ing")) {
    const b = w.slice(0, -3);
    out.push(b, b + "e");
    if (doubled(b)) out.push(b.slice(0, -1));
  }
  if (w.length > 5 && w.endsWith("est")) {                       // superlatives: nearest, biggest, latest
    const b = w.slice(0, -3);
    out.push(b, b + "e");
    if (doubled(b)) out.push(b.slice(0, -1));
  }
  if (w.length > 4 && w.endsWith("ied")) out.push(w.slice(0, -3) + "y");
  if (w.length > 3 && w.endsWith("ed")) {
    const b = w.slice(0, -2);
    out.push(b, b + "e");
    if (doubled(b)) out.push(b.slice(0, -1));
  }
  return [...new Set(out)].filter((c) => c && c !== w);
}

const CONTRACTIONS = {
  "i'm": ["i", "am"], "can't": ["can", "not"], cannot: ["can", "not"], "won't": ["will", "not"],
  "shan't": ["shall", "not"], "ain't": ["is", "not"], "let's": ["let", "us"], "y'all": ["you", "all"],
  "it's": ["it", "is"], "that's": ["that", "is"], "what's": ["what", "is"], "where's": ["where", "is"],
  "who's": ["who", "is"], "how's": ["how", "is"], "when's": ["when", "is"], "why's": ["why", "is"],
  "there's": ["there", "is"], "here's": ["here", "is"], "he's": ["he", "is"], "she's": ["she", "is"],
};
const SUFFIXES = [["n't", "not"], ["'re", "are"], ["'ve", "have"], ["'ll", "will"], ["'d", "would"], ["'m", "am"]];
const NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Split one lowercased word into English words: "don't" -> [do, not], "maria's" -> [maria]. */
export function expandContraction(lower) {
  const w = lower.replace(/[‘’]/g, "'");
  if (CONTRACTIONS[w]) return CONTRACTIONS[w];
  for (const [suf, word] of SUFFIXES) {
    if (w.endsWith(suf) && w.length > suf.length) return [w.slice(0, -suf.length), word];
  }
  if (w.endsWith("'s")) return [w.slice(0, -2)];      // possessive
  if (w.endsWith("'")) return [w.slice(0, -1)];
  if (/^\d+$/.test(w)) return [NUMBERS[Number(w)] ?? w];
  return [w];
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*'?/gu;

/** Tokens of one sentence with original form and capitalization kept for name detection. */
export function tokenize(sentence) {
  const out = [];
  for (const m of sentence.matchAll(WORD_RE)) {
    const raw = m[0];
    const parts = expandContraction(raw.toLowerCase());
    const base = raw.replace(/(['’].*)$/u, "");
    parts.forEach((w, k) => out.push({
      w,
      orig: k === 0 ? base : w,
      raw,
      start: m.index, // char offset of the raw word in `sentence`
      cap: k === 0 && /^\p{Lu}/u.test(raw),
    }));
  }
  return out;
}

/** Normalized key for a vocab gloss: "THANK YOU" -> "thank you", "don't want" -> "do not want". */
export function glossKey(gloss) {
  return tokenize(String(gloss)).map((t) => t.w).join(" ");
}

const ABBREV = /\b(?:dr|mr|mrs|ms|st|prof|jr|sr|vs)\.$/i;

/** Split text into sentences, keeping the terminator (".", "?", "!"). */
export function splitSentences(text) {
  const chunks = [];
  const re = /[^.!?]+(?:[.!?]+|$)/g;
  for (const m of String(text).matchAll(re)) {
    const s = m[0];
    if (chunks.length && ABBREV.test(chunks[chunks.length - 1].trim())) chunks[chunks.length - 1] += s;
    else chunks.push(s);
  }
  return chunks.map((s) => s.trim()).filter((s) => /[\p{L}\p{N}]/u.test(s))
    .map((s) => ({ text: s, question: /\?\s*$/.test(s), statement: /[.!]\s*$/.test(s) }));
}

/** A-Z only, accents stripped: "José" -> "JOSE". Empty string if nothing is left (e.g. Greek script). */
export function toFingerspell(word) {
  return String(word).normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z]/g, "");
}

/** Same motion_id convention as pipeline/sign-clips.mjs: uppercase, non-alphanumerics -> "_". */
export function toMotionId(gloss) {
  return String(gloss).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Words that signal the next capitalized word is a name: "my name is X", "I am X", "called X", "Dr. X". */
export function isNameCue(prev2, prev1) {
  if (["named", "called", "meet", "dr", "mr", "mrs", "ms", "miss", "prof"].includes(prev1)) return true;
  return (prev2 === "name" && prev1 === "is") || (prev2 === "i" && prev1 === "am") || (prev2 === "this" && prev1 === "is");
}
