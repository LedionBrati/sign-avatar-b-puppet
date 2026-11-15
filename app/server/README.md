# app/server: SIGNLAYER local API (contract: `app/core/src/api.ts`)

`cd translate && npm i` once (and `cd app/server && npm i` for the optional agent layer: the `openai` SDK is its only dependency), then `node app/server/index.mjs` (binds 0.0.0.0, `PORT` default 8787, prints local + LAN URLs). `npm test` here runs `node --test test/`.
`CLIPS_DIR=dirA,dirB` merges clip sets (`manifest.json` each; first dir wins on a motion_id); only manifest files that exist are served, at `/clips/<file>` with Range/206. `SEMANTIC=0` = rules only.
Routes: `GET /api/health`, `GET /api/vocab`, `POST /api/sign {text, semantic?, agent?}` (text ≤ 500 chars; errors are `{error:{code,message}}`), `GET /api/sign.mp4?text=` (joined mp4 via ffmpeg). CORS open to any origin.
The semantic model warms in the background (~0.5 s with `translate/cache/`); until `health.semantic` is `"ready"`, `/api/sign` uses rules only. `word_index` comes from the translator's `source_index`.
Sign -> voice: `POST /api/recognize?mode=sign|spell` (float32 body `frames x 543 x 3`, header `X-Frames`, max 384 frames) is proxied to `app/recognizer` at `RECOGNIZER_URL` (default `http://127.0.0.1:8788`); `503 recognizer_down` if it is not running, and `health.recognizer` is `"ready"` or `"down"`. Bodies are never logged (face points are biometric).
`GET /app/*` serves the built web app from `app/web/dist` (or `WEB_DIST`) with SPA fallback to `index.html`; `404 no_web_build` until it is built. Build the web app with a relative or `/app/` base so its assets resolve under `/app/`.

# Playback safety

The server evaluates every translator plan against the loaded clips before returning a signing playlist. See [the safety API and client handoff](../../docs/semantic-safety.md). Blocked or ambiguous messages have an empty playlist and retain the exact original caption; `/api/sign.mp4` returns HTTP 422 for them.

# Agent layer (optional, OpenAI)

When the local translator's plan is not `fully_supported`, the server can ask an LLM to plan the sentence by meaning (paraphrase into the signs that exist). The agent's plan goes through the same playlist builder and safety gate, and it is returned only if the gate rates it strictly better (`translator: "agent"`, plus `paraphrase`). Otherwise the local result is returned. Every agent `motion_id` is checked against the vocab, and an invented one is rejected. A paraphrased sign is `semantic`, so the gate answers `needs_confirmation` and the sign does not auto-play. Details and eval: [experiments/2026-11-15-agent-layer.md](../../experiments/2026-11-15-agent-layer.md).

| env | default | |
|---|---|---|
| `OPENAI_API_KEY` | – | key in the environment |
| `OPENAI_API_KEY_FILE` | – | path to a file holding the key (first non-empty line, trimmed, read at startup). Use this rather than putting the key in shell history |
| `OPENAI_MODEL` | `gpt-5.4-mini` | any Responses-API model with structured outputs |
| `AGENT` | on if a key is set | `AGENT=off` disables the agent even with a key |
| `AGENT_TIMEOUT_MS` | `6000` | total budget per sentence (1 retry only if ≥ 750 ms remain); on failure the local result is returned with a warning |
| `AGENT_REASONING` | `none` | reasoning effort for gpt-5 / o-series models |
| `EVAL_VOCAB` | – | **dev only**: `dictionary` plans against the 1,945-sign dictionary with virtual clips (responses labelled `eval: "virtual_clips"`, `sign.mp4` refuses) |

Per request: `POST /api/sign {text, agent: "auto" | "always" | "off"}` (default `auto`; `GET /api/sign.mp4?agent=`). `health.agent` is `"ready"` or `"off"`. Responses where the agent was asked include an `agent` trace (status, paraphrase, notes, model, latency, tokens, rejected items).
**Privacy:** with the agent on, the text of every sentence the local translator cannot fully sign is sent to OpenAI (`store: false`). Sentences signed locally are never sent. **Secrets:** the key is never logged, echoed or returned. Every log line and agent error is redacted. Tests use a fake client and ignore any key in the environment.
Dev scripts: `scripts/agent-models.mjs` (model IDs available to the key), `scripts/agent-try.mjs "text" [--vocab dictionary]`, `scripts/agent-eval.mjs clips|dictionary` (against a running server).
