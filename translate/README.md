# translate: English -> ASL sign plan, no LLM, no API

```sh
cd translate && npm install                       # once: transformers.js + English word list
node translate/cli.mjs "Where does it hurt?"      # vocab = 9 clips; prints plan + timings
node translate/cli.mjs "I am exhausted." --vocab dictionary --warm   # 1,945 WLASL glosses, semantic layer
node translate/cli.mjs "..." --no-semantic --json # rules only (sync, ~0.2 ms), full plan JSON
node pipeline/speak.mjs "Thank you, see you later." --clips out/realtime/clips --out out/speak/t.mp4 [--partial]
cd translate && npm test                          # 60 tests; npm run test:rules skips the model
```
`translate(text, vocab, opts)` / `translateRules(...)` in `index.mjs` (Node + browser) return a sign plan (shape: `assertPlan` in `shared/contracts.mjs`) that passes it when `plan.ok`. Layers: rules (`rules.mjs`: contractions, phrases, lemmas, synonyms, drop list, time-front / WH-end / markers) -> local MiniLM embeddings for leftovers (`semantic.mjs`, threshold 0.70, model + vocab embeddings cached in `translate/cache/`, works offline with `--offline`) -> fingerspell names, else `unsupported_tokens`. Never invents a motion_id. This is signed English with ASL-ish order, **not ASL grammar** and not signer-reviewed: see `experiments/2026-11-15-translate-no-llm.md`.

Vocab sources (`node.mjs`, Node only): `--vocab clips` = `SIGN_CLIPS_DIR` or `<repo>/out/realtime/clips`; `--vocab dictionary` = `SIGN_DICTIONARY`, the path to the WLASL `index.json` (not in the repo, so it must be set; the dictionary tests skip without it). `coverage.mjs` also reads `RECOGNIZER_MAP` (default `app/recognizer/models/gislr_labels.json`); `NO_SEMANTIC=1` skips the model in the tests. `toMotionId` in `rules.mjs` is the one gloss -> motion_id rule (`pipeline/lib/clips.mjs` and `pipeline/produce/lib.mjs` re-export it as `toId`).

Each sign / fingerspell item carries `source_index`: the index in `plan.input_text.split(" ")` of the spoken word it came from (first word of a phrase), so apps can highlight it in captions even after ASL-ish reordering.
