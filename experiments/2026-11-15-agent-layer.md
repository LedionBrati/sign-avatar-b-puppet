# 2026-11-15: LLM agent layer for English -> sign (OpenAI), behind the safety gate

**Who:** Nikos (with Claude)
**Question:** Can an LLM that plans *by meaning* (paraphrase into the signs we have) sign more everyday English than the local rules + MiniLM translator, without ever inventing a sign or getting around Alex's all-or-nothing safety gate, and at what latency/cost?
**Why it matters:** With 9 clips the local translator can fully sign only a few sentences. "Thanks a lot, catch you later" fails on "lot" and "catch", although THANK-YOU SEE YOU LATER says the same thing. A meaning-level planner can bridge that gap, but only if code, not the model, decides what is safe to play.

## Setup
- Code: `app/server/lib/agent.mjs` (planner + validation), `lib/secrets.mjs` (key loading + redaction), `lib/eval-vocab.mjs` (dev-only virtual clips), hybrid routing in `app/server/index.mjs`, types in `app/core/src/api.ts`, tests in `app/server/test/agent.test.mjs` (fake OpenAI client), scripts `agent-models.mjs`, `agent-try.mjs`, `agent-eval.mjs`.
- Vocab: the 9-clip manifest (HELLO MY NAME THANK_YOU SEE YOU LATER WHERE HURT, no letter clips) and the 1,945-gloss dictionary (`EVAL_VOCAB=dictionary`, dev only: every gloss and A–Z gets a *virtual* clip, so the gate judges plan quality; responses are labelled `eval: "virtual_clips"` and `sign.mp4` refuses with 409).
- Model: **`gpt-5.4-mini`**, Responses API, `reasoning: {effort: "none"}`, strict JSON-schema structured output, `store: false`, `max_output_tokens: 1500`, `prompt_cache_key` per vocab hash. Configurable with `OPENAI_MODEL`. Non-reasoning models get `temperature: 0`. If the API rejects `temperature`/`reasoning` for a model, the call is retried once without that parameter.
- Model choice: `client.models.list()` on the key offered gpt-4.1(-mini), gpt-4o(-mini), gpt-5 / 5-mini / 5-nano, gpt-5.1, 5.2, 5.4 (+mini/nano), 5.5, and several gpt-5.6/6.x tiers. I compared three small, fast models on two sentences (6 calls, same prompt):
  | model | "Thanks a lot, catch you later" | "Where does your head hurt?" | latency |
  |---|---|---|---|
  | gpt-5.4-mini | THANK_YOU SEE~ YOU LATER | HURT~ WHERE, honest: "your" unsupported | 4.8 s cold, 1.8 s |
  | gpt-4.1-mini | same | **WHERE MY HURT**: WH not last, and MY for "your" | 1.5 s, 3.5 s |
  | gpt-5.4-nano | same | WHERE HURT MY: MY for "your", and lists "hurt" as unsupported while using HURT | 1.9 s, 1.7 s |
  gpt-5.4-mini was the only model that kept the person ("your" is not MY) and put the WH sign last, at similar warm latency. Its first call includes the one-off schema processing.
- Prompt design: a static `instructions` block of about 450 tokens with the rules (meaning over words, only listed IDs, keep person/number/time/negation, which words may be dropped, ASL-ish order, markers by item index, fingerspell names, `covers` semantics, paraphrase + notes). Then a `developer` message with the vocab, also static per vocab: IDs only, `ID=gloss` when the gloss is not derivable, `(sense)` when known. 9 signs = ~60 tokens; 1,945 signs = ~6.2k tokens. Then the user message with numbered words `0:Thanks 1:a 2:lot, ...`. Static parts come first, so OpenAI prompt caching applies (dictionary: 6,528 of ~6,670 input tokens cached from the second call on). The schema is static too, with no per-vocab `enum`, so invented IDs reach code validation and are counted.
- Output schema: `items[] {type: sign|fingerspell, id|null, letters|null, source (word index), covers (word indices), confidence}`, `markers[] {question_wh|question_yn|negation, from, to}`, `unsupported[]` (word indices), `paraphrase`, `notes`.
- Validation in code (`buildPlan`), the model only proposes:
  1. `id` must be in the vocab (a spacing slip like "THANK YOU" for THANK_YOU is normalized). Otherwise the item is **rejected** (`not_in_vocab`) and its words become unsupported.
  2. Fingerspelling must spell the source word (A–Z) and must not be a pronoun or function word (`fingerspell_mismatch`, `fingerspell_function_word`).
  3. The match method is re-derived. If `translateRules` on the item's core words gives exactly this sign by exact/phrase/lemma/synonym, the item keeps that method. Anything else is `semantic`, with the model's confidence as `score`, and **the gate turns semantic into `needs_confirmation`**, the same rule it applies to local MiniLM matches.
  4. A sign may claim only the words it renders, droppable words (the local DROP list), and meaning-light extras ("a lot", "so much", "there" in "hey there", adjacent phrasal particles). Any other content word it claims is `overclaimed_cover` and becomes unsupported. A content word nobody claims also becomes unsupported. Uncovered droppable words go to `dropped_tokens`, so the gate still sees a risky dropped "it".
  5. Markers are remapped after rejected items. The plan must pass `assertPlan`.
- Hybrid routing in `POST /api/sign` (and `GET /api/sign.mp4`): the local translator runs first (rules ~0.2 ms, warm MiniLM ~15 ms). If the gate says `fully_supported`, that result is returned (`translator: "local"`) and the agent is not called. Otherwise the agent plans and its plan goes through the **same** `planToPlaylist` + `assessSigning`. The agent result is returned (`translator: "agent"`, `paraphrase`) only if the gate rates it strictly better (`fully_supported` > `needs_confirmation` > `caption_only`; with two `needs_confirmation` results, fewer open reasons wins). Ties go to local. `agent: "always"` prefers a valid agent plan, and `agent: "off"` skips it. Any agent failure (timeout, HTTP error, bad JSON, invalid plan) returns the local result with `warnings: ["agent unavailable (<code>); local translation used"]`. Every response where the agent was asked carries an `agent` trace: status, local_status, paraphrase, notes, model, cached, latency_ms, usage, rejected, and the plan that was not chosen.
- Budget: 6 s total per sentence. One retry, only if at least 750 ms of budget remain (so a timeout is not retried). SDK `maxRetries: 0`. LRU cache of 200 entries keyed by sha256(model + vocab hash + normalized text).
- Commands:
  ```sh
  cd app/server && npm i && cd ../..
  node --test app/server/test/*.test.mjs                         # 45 pass (semantic on), no network
  OPENAI_API_KEY_FILE=/path/key.txt node app/server/scripts/agent-models.mjs
  OPENAI_API_KEY_FILE=/path/key.txt PORT=8797 node app/server/index.mjs
  API_URL=http://127.0.0.1:8797 node app/server/scripts/agent-eval.mjs clips out.json
  EVAL_VOCAB=dictionary OPENAI_API_KEY_FILE=/path/key.txt PORT=8798 node app/server/index.mjs
  API_URL=http://127.0.0.1:8798 node app/server/scripts/agent-eval.mjs dictionary out.json
  OPENAI_API_KEY_FILE=/path/key.txt node app/server/scripts/agent-try.mjs "Thank you so much!" [--vocab dictionary]
  ```

## Result
`~` = semantic (paraphrased) sign, so the gate asks for confirmation. Neither `needs_confirmation` nor `caption_only` plays anything (all-or-nothing). The 9-clip round ran with the validation as of commit `f6e8428`, the dictionary round at `f3b0b35` (cover rule in). Rows marked † were re-run with `agent-try.mjs` after the later fixes (`f3b0b35` cover rule, `ef56713` fingerspelling, `11b5b4d` literal core), and the final column shows the outcome under the shipped rules.

**9 clips (25 sentences + 1 cache repeat)**

| # | sentence | local (status) | agent (status) | winner | agent ms | final rules |
|---|---|---|---|---|---|---|
| 1 | I've had a headache since yesterday | – (caption) | HURT~ (caption) | local | 2568 | |
| 2 | Thanks a lot, catch you later | THANK_YOU YOU LATER (caption) | THANK_YOU~ SEE~ YOU LATER (confirm) | **agent** | 1633 | † same, confirm |
| 3 | Hi, I'm Maria | HELLO fs:MARIA (caption: no letter clips) | same (caption) | local | 1495 | |
| 4 | Where does it hurt? | HURT WHERE (**full**) | not called | local | – | |
| 5 | Can you help me find a doctor? | YOU (caption) | YOU SEE~ WHERE~ (caption) | local | 1548 | |
| 6 | Hello, thank you. | HELLO THANK_YOU (**full**) | not called | local | – | |
| 7 | Hey there! | HELLO (caption: "there") | HELLO~ (confirm) | **agent** | 1082 | † same, confirm |
| 8 | See ya later! | SEE LATER (caption: "ya") | SEE YOU~ LATER (confirm) | **agent** | 1435 | † same, confirm |
| 9 | Hello, my name is Maria. | HELLO MY NAME fs:MARIA (caption) | same (caption) | local | 1619 | |
| 10 | Where does your head hurt? | HURT WHERE (caption) | WHERE HURT (caption); **YOUR, HEAD invented → rejected** | local | 1432 | † same rejections |
| 11 | Thank you so much! | THANK_YOU (caption) | THANK_YOU~ (confirm) | **agent** | 1099 | † confirm (after the literal-core fix) |
| 12 | Good to see you. | SEE YOU (caption) | SEE~ YOU (confirm): "good" absorbed into SEE | agent | 1347 | † **caption**: "Good" unsupported |
| 13 | Bye, see you soon. | SEE YOU (caption) | SEE~ YOU LATER~ (caption: "Bye") | local | 1493 | |
| 14 | Hello, nice to meet you. | HELLO YOU (caption) | HELLO YOU (caption) | local | 1621 | |
| 15 | Where is the bathroom? | WHERE (caption) | WHERE (caption) | local | 1124 | |
| 16 | My stomach hurts. | MY HURT (caption) | HURT~ MY (confirm), paraphrase still says "stomach" | agent | 1378 | † **caption**: stomach `overclaimed_cover` |
| 17 | Does it hurt here? | HURT (caption) | HURT~ WHERE~ (caption: "here", dropped "it") | local | 1279 | |
| 18 | I don't feel well. | – (caption) | HURT~ (caption: negation) | local | 1496 | |
| 19 | Thanks, see you later! | THANK_YOU SEE YOU LATER (**full**) | not called | local | – | |
| 20 | Where are you? | YOU WHERE (**full**) | not called | local | – | |
| 21 | What's your name? | NAME (caption) | NAME~ (caption) | local | 1266 | |
| 22 | Hello! Long time no see. | HELLO SEE (caption) | HELLO SEE YOU~ (caption: negation "no") | local | 1728 | |
| 23 | My back hurts a lot. | MY HURT (caption) | HURT~ (caption) | local | 1452 | |
| 24 | Where do I catch the bus? | WHERE (caption) | WHERE (caption) | local | 1334 | |
| 25 | Turn right at the bank. | – (caption) | WHERE~ (caption) | local | 1219 | |
| 26 | Thanks a lot, catch you later (repeat) | | cache hit | agent | 0.3 | |

Round 1: 21 agent calls, 7 agent wins, 0 failures. Under the final rules **5 wins** (#2, #7, #8, #11 and the repeat). #12 and #16 were model overclaims that the stricter cover rule now blocks. All wins are `caption_only → needs_confirmation`: the agent turns "can't sign this" into "sign THANK-YOU SEE YOU LATER, meaning *Thank you very much, see you later*?", which a client can show for confirmation. Nothing new plays automatically, because the gate never auto-plays a paraphrase.

**1,945-sign dictionary, virtual clips (15 sentences + 1 cache repeat)**

| # | sentence | local (status) | agent (status) | winner | agent ms | in/cached/out tokens |
|---|---|---|---|---|---|---|
| 1 | I've had a headache since yesterday | YESTERDAY I HAVE HAVE HEADACHE SINCE (caption: **invalid_plan**, see below) | HEADACHE SINCE YESTERDAY (caption: "I've", "had") | local | 1625 | 6673/0/133 |
| 2 | Thanks a lot, catch you later | THANK_YOU A_LOT CATCH YOU LATER (**full**) | not called | local | – | |
| 3 | Hi, I'm Maria | HELLO I fs:MARIA (**full**) | not called | local | – | |
| 4 | Can you help me find a doctor? | CAN YOU HELP ME FIND DOCTOR (**full**) | not called | local | – | |
| 5 | Where is the nearest pharmacy? | NEAR WHERE (caption) | WHERE (caption); **PHARMACY invented → rejected** | local | 1159 | 6670/6528/124 |
| 6 | I feel dizzy and tired. | I FEEL DIZZY AND TIRED (**full**) | not called | local | – | |
| 7 | My spouse needs help. | MY HUSBAND~ NEED HELP (caption: semantic_substitution) | HUSBAND~ NEED HELP (caption: "spouse" overclaimed under HUSBAND) | local | 1219 | 6667/6528/132 |
| 8 | I am exhausted. | I TIRED~ (confirm) | TIRED~ (caption: dropped "I") | local | 921 | 6663/6528/70 |
| 9 | How much does the ticket cost? | MUCH TICKET COST HOW (**full**) | not called | local | – | |
| 10 | Where is the train station? | TRAIN RADIO~ WHERE (confirm) | TRAIN WHERE (caption); **STATION invented → rejected** | local | 1096 | 6669/6528/140 |
| 11 | Please call an ambulance. | PLEASE CALL (caption) | PLEASE CALL (caption); **AMBULANCE invented → rejected** | local | 1174 | 6667/6528/134 |
| 12 | I'm allergic to penicillin. | I ALLERGY~ (caption) | ALLERGY~ fs:PENICILLIN (caption: "penicillin" overclaimed) | local | 1120 | 6668/6528/120 |
| 13 | Could you speak slower, please? | YOU SPEAK SLOW~ PLEASE (caption: "Could") | SLOW~ SPEAK YOU PLEASE (caption) | local | 1297 | 6672/6528/157 |
| 14 | Nice to meet you, have a good day! | GOOD DAY NICE MEET YOU HAVE (**full**) | not called | local | – | |
| 15 | I lost my passport. | I LOSE MY (caption) | fs:I (caption); **PASSPORT invented → rejected**, "I" fingerspelled | local | 1382 | 6665/6528/91 |
| 16 | Thanks a lot, catch you later (repeat) | | not called | local | – | |

Dictionary: 9 agent calls and 0 agent wins. With 1,945 signs the local translator is already strong (6/15 fully supported, 2 need confirmation), and the agent never beat it. It still caught a real local bug: "spouse" was mapped to HUSBAND by embeddings (the gate blocks that as `semantic_substitution`; the agent's HUSBAND was blocked as an overclaim).

**Invented-sign attempts caught by validation:** 6 `not_in_vocab` (YOUR, HEAD with 9 clips; PHARMACY, STATION, AMBULANCE, PASSPORT with the dictionary), 3 `overclaimed_cover` (HURT⊃stomach, HUSBAND⊃spouse, ALLERGY⊃penicillin), 1 `fingerspell_function_word` (I). None reached a playlist. With a long vocab the model "assumes" common words exist despite the instruction. Validation is what makes this safe.

**Latency (agent call only, 30 uncached calls):** p50 **1.35 s**, p95 **1.73 s**, min 0.92 s, max 2.57 s (the first call after start). 9 clips: p50 1.44 s / p95 1.73 s. Dictionary: p50 1.17 s / p95 1.63 s, faster thanks to the cached prefix. Local-only responses (agent not called): 3–10 ms wall. Cache hit: 0.3 ms. No timeouts in 30 calls with the 6 s budget.

**Tokens / cost:** 9 clips: ~721 input + ~109 output tokens per call. Dictionary: ~6,670 input (6,528 cached after the first call) + ~122 output. At an *assumed* gpt-5.4-mini price of $0.75/M input, $0.075/M cached input and $4.50/M output (check current OpenAI pricing), that is ≈ **$0.001 per sentence** for either vocab once the dictionary prefix is cached. The first uncached dictionary call is ≈ $0.006. Total live calls in this experiment: 48 (1 model list, 6 model comparison, 2 prompt checks, 30 eval, 9 re-checks).

## Failure modes seen
- **Invented IDs** (PHARMACY, STATION, ...): rejected in code, and the word becomes unsupported.
- **Overclaiming**: the model says HURT "covers" stomach and writes a paraphrase that still mentions the stomach. Fixed by the cover rule: a sign renders only its source (or its verified literal span) plus meaning-light extras. Without this rule a confirmation dialog would have shown a false paraphrase.
- **Paraphrase drift**: the paraphrase is the model's own sentence. Under the final rules every claimed word is rendered, so the risk is lower, but clients should show the glosses next to the paraphrase.
- **Dropping pronouns** ("I am exhausted" -> TIRED): ASL often drops them, but our rule treats an unrendered "I" as lost, so the message is caption-only. That is conservative on purpose.
- **Odd fingerspelling** (pronoun "I"): now rejected. Fingerspelling a drug name (PENICILLIN) is allowed: it is the source word.
- **Local translator bug found on the way** (not changed here): "I've" expands to two plan items whose `source` ("have") does not match the display word "I've", so the gate returns `invalid_plan` for "I've had a headache since yesterday" with the dictionary vocab. That belongs in `translate/` (source of contraction parts).
- Network/API failures fall back to local with a warning. Tested with the fake client (timeout, 503 then retry, bad JSON, 401 not retried).

## Privacy and secrets
- With the agent enabled, **the sentence text is sent to OpenAI** for every message the local translator cannot fully sign (never for fully supported ones, never with `agent: "off"` or `AGENT=off`). Requests use `store: false`. Do not enable it for conversations that must stay on device. Medical sentences are exactly the sensitive case.
- The key is read at startup from `OPENAI_API_KEY` or `OPENAI_API_KEY_FILE`, kept in memory, never logged or returned. All server log lines and agent errors pass through a redactor (the exact key plus any `sk-…` / `Bearer …` shape). Key-file errors name the path only. Tests check that an upstream error echoing the key is redacted in the response, the warnings and the logs. Under `node --test` the environment key is ignored, so tests make no paid calls.

## What I learned
- With 9 clips the agent adds real coverage only at the *meaning* level ("catch you later", "see ya", "hey there", "so much"). Under the gate's rules that becomes `needs_confirmation`, never auto-play. That is the right outcome until a confirmation route exists.
- With the 1,945-sign dictionary, the local rules + MiniLM are already better than the agent at this level of strictness. The agent is a fallback for idioms, not a replacement.
- Structured outputs make the response shape reliable (0 malformed responses in 47 planning calls), but not its content: 7 of the 30 eval calls contained an item validation had to reject, plus 2 overclaims found by reading the round-1 results (now blocked in code).
- Re-deriving match methods with the local rules keeps one consistent safety policy: a sign is "literal" only if the local rules agree, whoever proposed it.

## What I'd try next
- Send the model a per-sentence shortlist of the dictionary (MiniLM top-k per word) instead of 1,945 IDs. That means fewer invented IDs and fewer tokens.
- A confirmation route: client shows glosses + paraphrase for `needs_confirmation` and the user approves, then playback. Needs Alex's sign-off on the gate.
- Fix the contraction `source` bug in `translate/` ("I've" -> I HAVE).
- Sense metadata in the clip manifest (`sense`), which the prompt already supports, so homographs can be resolved instead of blocked.
