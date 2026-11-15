# 2026-11-15: English -> sign plan without an LLM

**Who:** Nikos (with Claude)
**Question:** Can we turn everyday English into a README §6.5 plan locally (no fal, no Anthropic, no remote model calls) quickly enough to drive the real-time clip player, and how wrong is it?
**Why it matters:** The race demo needs text -> video in well under a second. An API call costs time and money, and it fails when the network is down. A local translator also makes the "can't sign this yet" list explicit: it never invents a sign.

## Setup
- Inputs: the 9-sign clip set `sign-avatar-b-puppet/out/realtime/clips` (HELLO MY NAME THANK_YOU SEE YOU LATER WHERE HURT) and the full dictionary `ai-summit/data/signs/index.json` (1,945 WLASL glosses, motion_id = uppercase, non-alphanumerics -> `_`).
- Code: `translate/` (plain ESM, Node + browser core: `index.mjs`, `rules.mjs`, `semantic.mjs`; Node helpers `node.mjs`; `cli.mjs`), `pipeline/speak.mjs`, and `pipeline/lib/clips.mjs` (the `say` join logic, now shared with `sign-clips.mjs say`).
- Layers, cheapest first:
  1. Rules: contractions, longest phrase first, lemmas (irregular table plus -s/-es/-ies/-ing/-ed/-est), a curated synonym table and a drop list (a, an, the, am/is/are/was/were/be, do/does/did, to, of, at, it, fillers).
  2. Ordering, approximate: time words go to the front, with a NEXT/LAST/THIS/EVERY/GOOD modifier kept with them. "later" is deliberately left in place. WH words go to the end with `question_wh` over the sentence. `?` with no WH word gives `question_yn`. NOT/NEVER/CANNOT/DON'T-WANT give `negation` from the sign to the end of the sentence.
  3. Semantic: `Xenova/all-MiniLM-L6-v2` q8 via `@huggingface/transformers` 3.8. Each leftover content word takes its nearest vocab gloss by cosine similarity and is accepted at 0.70 or above. Two guards apply. A gloss that is the query plus extra letters is rejected (wrist ≠ WRISTWATCH). A multiword gloss that contains the query's stem is rejected (turn ≠ TAKE_TURNS, peanuts ≠ PEANUT_BUTTER). Question words and negations are never semantic targets.
  4. Names: capitalized mid-sentence, after a name cue ("name is", "I am", "called", "Dr."), or missing from the 275k-word English list -> fingerspell A–Z (accents stripped). Anything else -> `unsupported_tokens`.
- Every item records `match: {method: exact|phrase|lemma|synonym|semantic|fingerspell, score?, alternatives?}`. assertPlan accepts the extra fields. Below-threshold candidates go in `plan.near_misses`. If nothing is signable, `plan.ok` is false and `items` is empty, so assertPlan rejects the plan on purpose and nothing plays.
- Commands:
  ```sh
  cd translate && npm install && npm test                 # 59 tests, all pass (rules-only: 48 pass, 11 skipped)
  node translate/cli.mjs "Where does it hurt?" --warm
  node translate/cli.mjs "I am exhausted." --vocab dictionary --offline --warm
  C=../sign-avatar-b-puppet/out/realtime/clips
  node pipeline/speak.mjs "Hello, my name is Maria." --clips $C --out out/speak/hello-my-name-maria.mp4 --partial
  node pipeline/speak.mjs "Thank you, see you later." --clips $C --out out/speak/thank-you-see-you-later.mp4
  node pipeline/speak.mjs "Where does it hurt?" --clips $C --out out/speak/where-does-it-hurt.mp4
  ffprobe -v error -show_entries format=duration:stream=nb_frames out/speak/*.mp4
  ```

## Result
Race sentences, with the 9 clips (`out/speak/`, gitignored):

| sentence | plan | video | ffprobe |
|---|---|---|---|
| Hello, my name is Maria. | HELLO MY NAME + fingerspell MARIA | HELLO MY NAME only (`--partial`; no letter clips, so MARIA is listed as skipped) | 115 frames, 4.79 s (= 42+33+40) |
| Thank you, see you later. | THANK_YOU SEE YOU LATER | all 4 | 154 frames, 6.42 s |
| Where does it hurt? | HURT WHERE, question_wh 0-1 (dropped: does, it) | both | 86 frames, 3.58 s |

Without `--partial`, sentence 1 exits 1 with `can't sign all of this yet: MARIA`. "I see you" exits 1 with `I` unsupported, because I is not in the 9 clips.

Timings (Windows 11 laptop, Node 22):

| what | ms |
|---|---|
| rules layer, warm, avg over 1,000 sentences (clips / dictionary) | 0.24 / 0.19 |
| rules layer, first call in a process (JIT, regex compile) | 18–42 |
| English word list load (275k words, once per process) | 70–600 |
| model first-ever download + load (23 MB q8) | 5,354 |
| dictionary vocab embeddings, first time (1,945 glosses, then cached on disk) | 13,482 |
| model load from disk cache (cold process), `--offline` works | 305–370 (first runs after download 1,565–1,800) |
| vocab embeddings from disk cache | 2–66 |
| semantic, warm, per sentence (1–3 leftover words) | 3–60, typically 5–25 |
| speak.mjs, rules only, warm disk: translate / assemble / total | 2–5 / 80–95 / 83–100 |
| speak.mjs, very first run (cold ffmpeg, Defender scan) | assemble 1,566–1,872 |
| speak.mjs with semantic (cold process): translate | 463 (366 is model load) |

## Threshold
I calibrated on about 75 words against the dictionary and chose **0.70**:
- **Accepted, good:** automobile→CAR 0.84, kitten→CAT 0.75, puppy→DOG 0.80, hospitalized→HOSPITAL 0.75, migraine→HEADACHE 0.75, terrified→SCARED 0.85, exhausted→TIRED 0.76, beverage→DRINK 0.80, instructor→TEACHER 0.72, smartphone→PHONE 0.72, horrible→TERRIBLE 0.88, allergic→ALLERGY 0.80, lovely→BEAUTIFUL 0.75, cash→MONEY 0.70.
- **Accepted, wrong or doubtful:** spouse→HUSBAND 0.86 (WIFE 0.85 is right behind; gender is invented), wrist→WRISTWATCH 0.76 and flat→FLATTER 0.78 (now rejected by the guard), Turn→TAKE_TURNS 0.80 and peanuts→PEANUT_BUTTER 0.76 (now rejected by the compound guard).
- **Rejected (< 0.70), mostly correctly:** unwell→EMERGENCY 0.54 (the synonym table covers it), medic→MEDICINE 0.62, pharmacist→PHYSICIAN 0.63, pharmacy→DRUG 0.62, ambulance→EMERGENCY 0.65, elbow→ARM 0.66, injection→SPRAY 0.53, leg→BODY 0.59, maria→HER 0.52, queasy→Q 0.50.
- **Rejected but would have been fine:** slowly→SLOW 0.69, weary→TIRED 0.65, infant→CHILD 0.66 (the synonym gives BABY), jogging→EXERCISE 0.64.
- Between 0.60 and 0.70 the false positives outnumber the hits, and above 0.75 we would lose kitten and hospitalized. So 0.70 is the knee. This is single-word MiniLM, so scores move by about ±0.01 depending on what is batched with the word.

## Eyeballed plans (dictionary vocab, semantic on)
Good:
- "Good morning, how are you feeling today?" → GOOD MORNING TODAY YOU FEEL HOW, question_wh 0-5
- "We watched a movie last night with our kids." → LAST NIGHT WE WATCH MOVIE WITH OUR KID
- "I need to see a doctor right now." → NOW I NEED SEE DOCTOR
- "Do you take your medication every morning?" → EVERY MORNING YOU TAKE YOUR MEDICINE, question_yn
- "The weather is lovely today." → TODAY WEATHER BEAUTIFUL (semantic 0.75)
- "My grandmother lives in Athens." → MY GRANDMOTHER LIVE IN fingerspell ATHENS
- "Please call an ambulance, my husband can't breathe." → PLEASE CALL MY HUSBAND CANNOT BREATHE, negation; ambulance unsupported (best EMERGENCY 0.65)

Bad (known failures):
- **Homographs:** "Turn right at the bank" → RIGHT BANK. The dictionary has one RIGHT and one BANK, and we cannot tell the senses apart. "You have to pay a fine" → FINE (the "I'm fine" sign, not a penalty). "She broke her leg" → BROKE (the no-money sign). "The latest one" → LATE.
- **Semantic gender guess:** "my spouse" → HUSBAND.
- **Signed English, not ASL:** "Can you write it down for me?" → CAN YOU WRITE DOWN FOR ME. There is no topicalization, no classifiers, no indexing (IX): "it" and "he/she" placement are dropped or signed literally. Our "let's" becomes LET + unsupported "us".
- **Markers span the whole comma-joined sentence:** in "Good morning, how are you…" the wh-face covers GOOD MORNING too.
- **Names that are English words at the start of a sentence** ("Grace is here", "Bob said") are not detected. The word list contains "maria", "grace", "bob", "paris". They are only caught mid-sentence or after a cue. "Dr. Smith" → DOCTOR + fingerspell SMITH (acceptable).

## What I learned
- For a vocab of 9–2,000 signs, rules carry almost everything. The semantic layer fires on about 1 in 4 everyday sentences and costs 5–25 ms warm. The real cost is the ~0.3 s model load per process, so keep one matcher alive in a server or page.
- MiniLM on single words is dominated by subwords (wrist/wristwatch, turn/take turns). Cheap lexical guards remove the worst false positives.
- Showing the nearest candidate and its score (`near_misses`) makes tuning honest: it shows a reviewer why a word was not signed.

## Limitations
- This is signed English with a few ASL-ish reordering rules (time first, WH last, markers). It is **not ASL grammar**, and no fluent Deaf signer has reviewed a single plan. The test expectations are regression tests of this translator, not ASL ground truth.
- Homographs are not disambiguated. Glosses carry no sense information yet (`catalog/signs.json` `sense` would be the place).
- The lists (drop, synonyms, time, irregulars) are short and hand-made. A dropped word such as "it" can hide meaning; the plan lists it in `dropped_tokens`.
- There are no letter clips yet, so every fingerspelled name blocks `speak.mjs` unless `--partial` is passed.

## What I'd try next
- Have a fluent signer review the ~60 test sentences and mark which plans are acceptable.
- Add sense tags for the top homographs (right, fine, bank, broke, left) and a small context rule or a manual override.
- Add FS_A..FS_Z letter clips so names play. `speak.mjs` already expands them when they exist in the manifest.
- In the browser, load the matcher once at page load and reuse it for every sentence.
