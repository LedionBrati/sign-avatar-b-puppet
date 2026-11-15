// node --test "translate/test/*.test.mjs"   (all tests; semantic ones load the local model)
// NO_SEMANTIC=1 node --test "translate/test/*.test.mjs"   or   node translate/test/translate.test.mjs --no-semantic
//
// Expected sequences are what THIS translator should output (signed English with simple
// ASL-ish ordering). They are regression tests, not signer-verified ASL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { assertPlan } from "../../shared/contracts.mjs";
import { translate, translateRules, SemanticMatcher } from "../index.mjs";
import { createNodeMatcher, defaultDictionaryPath, defaultClipsDir, loadEnglishWords, loadVocab } from "../node.mjs";

// The 9 signs in out/realtime/clips/manifest.json (inline so the tests do not need the clips).
const CLIPS = [
  ["HELLO", "HELLO"], ["MY", "MY"], ["NAME", "NAME"], ["THANK_YOU", "THANK YOU"], ["SEE", "SEE"],
  ["YOU", "YOU"], ["LATER", "LATER"], ["WHERE", "WHERE"], ["HURT", "HURT"],
].map(([motion_id, gloss]) => ({ motion_id, gloss }));
const dictPath = defaultDictionaryPath();
const DICT = dictPath ? loadVocab(dictPath) : null;
const noDict = !DICT && "dictionary index.json not found (set SIGN_DICTIONARY)";
const noSemantic = (process.env.NO_SEMANTIC === "1" || process.argv.includes("--no-semantic")) && "semantic tests disabled";
const englishWords = loadEnglishWords();

/** Compact view: HELLO MY NAME fs:MARIA */
const seq = (plan) => plan.items.map((i) => i.type === "sign" ? i.motion_id : `fs:${i.word}`).join(" ");

function check(plan, vocab) {
  assert.equal(plan.ok, true, "plan should have items");
  assertPlan(plan);
  const ids = new Set(vocab.map((v) => v.motion_id));
  for (const item of plan.items) {
    if (item.type === "sign") {
      assert.ok(ids.has(item.motion_id), `invented motion_id ${item.motion_id}`);
      assert.equal(item.gloss, vocab.find((v) => v.motion_id === item.motion_id).gloss);
    }
  }
  return plan;
}

const rules = (text, vocab) => check(translateRules(text, vocab, { englishWords }), vocab);

// [sentence, expected sequence, expected markers (type:from-to), expected unsupported]
const CLIP_CASES = [
  ["Hello, my name is Maria.", "HELLO MY NAME fs:MARIA", "", ""],            // team race sentence 1
  ["Thank you, see you later.", "THANK_YOU SEE YOU LATER", "", ""],         // team race sentence 2
  ["Where does it hurt?", "HURT WHERE", "question_wh:0-1", ""],             // team race sentence 3
  ["Where does it hurt", "HURT WHERE", "question_wh:0-1", ""],              // no "?" but wh-first
  ["Hi, my name's Nikos.", "HELLO MY NAME fs:NIKOS", "", ""],               // synonym + contraction
  ["Thanks! See you later.", "THANK_YOU SEE YOU LATER", "", ""],            // two sentences
  ["Hey, where's Maria?", "HELLO fs:MARIA WHERE", "question_wh:0-2", ""],  // where's -> where is
  ["Do you see it?", "YOU SEE", "question_yn:0-1", ""],                     // yes/no question
  ["It hurts.", "HURT", "", ""],                                            // -s lemma
  ["I'm hurt.", "HURT", "", "I"],                                           // I not in the 9 clips
  ["See you tomorrow.", "SEE YOU", "", "tomorrow"],                         // unknown -> unsupported
  ["Thank you very much.", "THANK_YOU", "", "very much"],
  ["Where did you see my name?", "YOU SEE MY NAME WHERE", "question_wh:0-4", ""],
];

const DICT_CASES = [
  ["Hello, my name is Maria.", "HELLO MY NAME fs:MARIA", "", ""],
  ["Thank you, see you later.", "THANK_YOU SEE YOU LATER", "", ""],
  ["Where does it hurt?", "HURT WHERE", "question_wh:0-1", ""],
  ["I don't want medicine.", "I DON_T_WANT MEDICINE", "negation:1-2", ""],  // phrase gloss "don't want"
  ["I can't sleep.", "I CANNOT SLEEP", "negation:1-2", ""],
  ["I am not sick.", "I NOT SICK", "negation:1-2", ""],
  ["I never eat meat.", "I NEVER EAT MEAT", "negation:1-3", ""],
  ["My children went to school yesterday.", "YESTERDAY MY CHILDREN GO SCHOOL", "", ""], // irregular + time fronting
  ["The doctors are coming tomorrow.", "TOMORROW DOCTOR COME", "", ""],    // plural + -ing + time
  ["I ate two apples this morning.", "THIS MORNING I EAT TWO APPLE", "", ""],
  ["I will see you next week.", "NEXT WEEK I WILL SEE YOU", "", ""],
  ["We were running.", "WE RUN", "", ""],                                   // doubled consonant -ing
  ["Babies cry.", "BABY CRY", "", ""],                                      // -ies plural
  ["I feel unwell.", "I FEEL SICK", "", ""],                                // synonym
  ["My tummy hurts.", "MY STOMACH HURT", "", ""],                           // synonym + lemma
  ["What is your name?", "YOUR NAME WHAT", "question_wh:0-2", ""],
  ["How are you?", "YOU HOW", "question_wh:0-1", ""],
  ["Are you deaf?", "YOU DEAF", "question_yn:0-1", ""],
  ["Is Maria a doctor?", "fs:MARIA DOCTOR", "question_yn:0-1", ""],
  ["When I was young, I lived in Paris.", "WHEN I YOUNG I LIVE IN fs:PARIS", "", ""], // not a question
  ["I met José at the hospital.", "I MEET fs:JOSE HOSPITAL", "", ""],      // accents stripped
  ["Xyzzy is here.", "fs:XYZZY HERE", "", ""],                              // not an English word
  ["Νίκος is here.", "HERE", "", "Νίκος"],                                  // no A-Z letters: unsupported
  ["I live in New York.", "I LIVE IN NEW_YORK", "", ""],                    // multiword gloss
  ["I want a lot of ice cream.", "I WANT A_LOT ICE_CREAM", "", ""],
  ["Dr. Smith is in the office.", "DOCTOR fs:SMITH IN OFFICE", "", ""],
  ["I need a quantum flux capacitor.", "I NEED", "", "quantum flux capacitor"],
  ["I need to see a doctor right now.", "NOW I NEED SEE DOCTOR", "", ""],  // "right now" -> NOW, fronted
  ["You have to pay.", "YOU MUST PAY", "", ""],                            // "have to" -> MUST
  ["Good morning, how are you?", "GOOD MORNING YOU HOW", "question_wh:0-3", ""],
];

const markers = (plan) => plan.nonmanual_markers.map((m) => `${m.type}:${m.from}-${m.to}`).join(" ");

for (const [text, expected, marks, unsupported] of CLIP_CASES) {
  test(`clips: ${text}`, () => {
    const plan = rules(text, CLIPS);
    assert.equal(seq(plan), expected);
    assert.equal(markers(plan), marks);
    assert.equal(plan.unsupported_tokens.join(" "), unsupported);
  });
}

for (const [text, expected, marks, unsupported] of DICT_CASES) {
  test(`dictionary: ${text}`, { skip: noDict }, () => {
    const plan = rules(text, DICT);
    assert.equal(seq(plan), expected);
    assert.equal(markers(plan), marks);
    assert.equal(plan.unsupported_tokens.join(" "), unsupported);
  });
}

test("match methods are reported per item", { skip: noDict }, () => {
  const plan = rules("Hi, the physicians went home.", DICT);
  assert.deepEqual(plan.items.map((i) => i.match.method), ["synonym", "lemma", "lemma", "exact"]);
  assert.equal(plan.items[1].motion_id, "PHYSICIAN");
  assert.deepEqual(plan.dropped_tokens, ["the"]);
});

test("nothing signable: ok=false, no invented signs, assertPlan would reject", () => {
  const plan = translateRules("Xylophone.", CLIPS, { englishWords });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.unsupported_tokens, ["Xylophone"]);
  assert.throws(() => assertPlan(plan));
});

test("rules layer is fast (< 1 ms per sentence warm)", { skip: noDict }, () => {
  const sentences = DICT_CASES.map((c) => c[0]);
  for (const s of sentences) translateRules(s, DICT, { englishWords });
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) translateRules(sentences[i % sentences.length], DICT, { englishWords });
  const avg = (performance.now() - t0) / 500;
  assert.ok(avg < 1, `average ${avg.toFixed(3)} ms`);
});

test("vocab loader reads the clips manifest when present", { skip: !defaultClipsDir() && "no clips dir" }, () => {
  const vocab = loadVocab("clips");
  for (const v of CLIPS) assert.ok(vocab.some((x) => x.motion_id === v.motion_id && x.gloss === v.gloss), v.motion_id);
});

test("semantic layer falls back to rules when the model cannot load", async () => {
  const broken = new SemanticMatcher({ importer: async () => { throw new Error("no model here"); } });
  const plan = await translate("I am exhausted, see you later.", CLIPS, { matcher: broken, englishWords });
  check(plan, CLIPS);
  assert.equal(seq(plan), "SEE YOU LATER");
  assert.match(plan.warnings.join(" "), /semantic layer unavailable \(no model here\)/);
  assert.deepEqual(plan.unsupported_tokens, ["I", "exhausted"]);
});

// ---- semantic (local embeddings), skip with NO_SEMANTIC=1 or --no-semantic ----
const matcher = noSemantic ? null : createNodeMatcher();
const sem = (text, vocab = DICT) => translate(text, vocab, { matcher, englishWords }).then((p) => check(p, vocab));
const semSkip = noSemantic || noDict;

const SEMANTIC_CASES = [
  // [sentence, expected sequence, words that must be semantic matches]
  ["I am exhausted.", "I TIRED", ["exhausted"]],
  ["The kitten is sleeping.", "CAT SLEEP", ["kitten"]],
  ["I was hospitalized yesterday.", "YESTERDAY I HOSPITAL", ["hospitalized"]],
  ["I have a migraine.", "I HAVE HEADACHE", ["migraine"]],
  ["That was horrible.", "THAT TERRIBLE", ["horrible"]],
];

for (const [text, expected, semWords] of SEMANTIC_CASES) {
  test(`semantic: ${text}`, { skip: semSkip }, async () => {
    const plan = await sem(text);
    assert.equal(seq(plan), expected);
    for (const w of semWords) {
      const item = plan.items.find((i) => i.source === w);
      assert.ok(item, `no item for ${w}`);
      assert.equal(item.match.method, "semantic");
      assert.ok(item.match.score >= 0.7, `${w} score ${item.match.score}`);
    }
  });
}

test("semantic: below threshold stays unsupported (pharmacist ~ physician 0.63)", { skip: semSkip }, async () => {
  const plan = await sem("The pharmacist called me.");
  assert.equal(seq(plan), "CALL ME");
  assert.deepEqual(plan.unsupported_tokens, ["pharmacist"]);
});

test("semantic: lexical-extension guard rejects wrist -> WRISTWATCH", { skip: semSkip }, async () => {
  const plan = await sem("My wrist hurts.");
  assert.equal(seq(plan), "MY HURT");
  assert.deepEqual(plan.unsupported_tokens, ["wrist"]);
});

test("semantic: compound guard rejects peanuts -> PEANUT_BUTTER", { skip: semSkip }, async () => {
  const plan = await sem("My daughter is allergic to peanuts.");
  assert.equal(seq(plan), "MY DAUGHTER ALLERGY");
  assert.deepEqual(plan.unsupported_tokens, ["peanuts"]);
  assert.equal(plan.near_misses[0].token, "peanuts");
});

test("semantic: names are fingerspelled, never embedded", { skip: semSkip }, async () => {
  const plan = await sem("Hello, my name is Maria.", CLIPS);
  assert.equal(seq(plan), "HELLO MY NAME fs:MARIA");
  assert.equal(plan.timings.semantic_ms, 0);
});

test("semantic: race sentences unchanged with the 9 clips", { skip: semSkip }, async () => {
  assert.equal(seq(await sem("Thank you, see you later.", CLIPS)), "THANK_YOU SEE YOU LATER");
  const p = await sem("Where does it hurt?", CLIPS);
  assert.equal(seq(p), "HURT WHERE");
  assert.equal(markers(p), "question_wh:0-1");
});

test("semantic: cache dir exists after a semantic run", { skip: semSkip }, () => {
  assert.ok(existsSync(new URL("../cache/", import.meta.url)));
});
