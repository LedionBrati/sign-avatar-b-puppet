# translate: English -> ASL sign plan, no LLM, no API

```sh
cd translate && npm install                       # once: transformers.js + English word list
node translate/cli.mjs "Where does it hurt?"      # vocab = 9 clips; prints plan + timings
node translate/cli.mjs "I am exhausted." --vocab dictionary --warm   # 1,945 WLASL glosses, semantic layer
node translate/cli.mjs "..." --no-semantic --json # rules only (sync, ~0.2 ms), full plan JSON
node pipeline/speak.mjs "Thank you, see you later." --clips out/realtime/clips --out out/speak/t.mp4 [--partial]
cd translate && npm test                          # 59 tests; npm run test:rules skips the model
```
`translate(text, vocab, opts)` / `translateRules(...)` in `index.mjs` (Node + browser) return a README §6.5 plan that passes `assertPlan` when `plan.ok`. Layers: rules (`rules.mjs`: contractions, phrases, lemmas, synonyms, drop list, time-front / WH-end / markers) -> local MiniLM embeddings for leftovers (`semantic.mjs`, threshold 0.70, model + vocab embeddings cached in `translate/cache/`, works offline with `--offline`) -> fingerspell names, else `unsupported_tokens`. Never invents a motion_id. This is signed English with ASL-ish order, **not ASL grammar** and not signer-reviewed: see `experiments/2026-11-15-translate-no-llm.md`.
