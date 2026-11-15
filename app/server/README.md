# app/server: SIGNLAYER local API (contract: `app/core/src/api.ts`)

`cd translate && npm i` once (and `cd app/server && npm i` for the optional agent layer: the `openai` SDK is its only dependency), then `node app/server/index.mjs` (binds 0.0.0.0, `PORT` default 8787, prints local + LAN URLs). `npm test` here runs `node --test test/`.
`CLIPS_DIR=dirA,dirB` merges clip sets (`manifest.json` each; first dir wins on a motion_id); only manifest files that exist are served, at `/clips/<file>` with Range/206. `SEMANTIC=0` = rules only.
With the mass clip set (`pipeline/mass/`, see `experiments/2026-11-15-mass-signs.md`), run from the repo root with `CLIPS_DIR=out/realtime/clips,out/realtime/clips-mass node app/server/index.mjs`: the hand-made set wins on overlap, and mass aliases (synonyms sharing one WLASL video) point at the same file.
Routes: `GET /api/health`, `GET /api/vocab`, `POST /api/sign {text, semantic?, agent?}` (text ≤ 500 chars; errors are `{error:{code,message}}`), `GET /api/sign.mp4?text=` (joined mp4 via ffmpeg). CORS open to any origin.
The semantic model warms in the background (~0.5 s with `translate/cache/`); until `health.semantic` is `"ready"`, `/api/sign` uses rules only. `word_index` comes from the translator's `source_index`.
Speech -> text (the extension's tab audio): `POST /api/transcribe` with one audio chunk (`audio/webm` opus from MediaRecorder; also ogg, wav, mpeg, mp4; up to 2 MB, optional `?lang=en`, `X-Audio-Ms` up to 30000) returns `{text, model, timings}`; `text` is empty for silence or music. It uses the same OpenAI key as the agent layer (`gpt-4o-mini-transcribe`, `TRANSCRIBE_MODEL` to override, `TRANSCRIBE=off` to disable); `health.transcribe` is `"ready"` or `"off"`, and without a key the route answers `503 transcribe_off`. Audio is never stored or logged. `node scripts/transcribe-bench.mjs <dir>` compares models on real chunks.
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

# Generate-on-use (optional, fal)

When a sentence needs a sign that has **motion** (an extracted `*.clean.json` in `MOTION_DIRS`) but **no realistic clip** yet, the server queues it and makes the clip in the background: one batch `NEUTRAL S1 NEUTRAL S2 … NEUTRAL` (`puppet/compose.mjs`, padded to ≥ 5 s, split above 14 s) → `puppet/render.mjs --view vrm` → H3 Max Recast 768P (`pipeline/lib/fal.mjs`, safety checker on) → output frames must equal input frames → cut with `cutClips` (`pipeline/lib/clips.mjs`, the `sign-clips.mjs cut` logic) into `ONDEMAND_CLIPS_DIR` (own `manifest.json`) → the clip library and vocab are **hot-reloaded** (no restart). The request that triggered it is **not delayed**: it returns what the safety gate allows now (captions only for the missing word) plus `generating: [{motion_id, gloss, eta_s}]`; clients show a "Generating SICK… ~2 min" chip. The next request with that word signs it. Words with no motion stay plain `unsupported`. One in-process worker, one batch at a time; a failed batch is retried once, then the sign is marked `failed` with a reason (it stays caption-only). Code: `lib/ondemand.mjs`; design and live timings: [experiments/2026-11-15-on-demand.md](../../experiments/2026-11-15-on-demand.md).

| env | default | |
|---|---|---|
| `ONDEMAND` | off | `on` enables it (also needs a fal key and `MOTION_DIRS`) |
| `FAL_KEY_FILE` / `FAL_KEY` | – | fal key (file: first non-empty line, read + trimmed at startup). Set as `FAL_KEY` inside the server process only; never passed to the render/compose child processes; redacted from every log, error and status |
| `MOTION_DIRS` | – | comma-separated motion folders (`motion/batch_library.py` output). `summary.csv` rows with an `error` or < `ONDEMAND_MIN_HAND_PCT` (80) % dominant-hand detection are skipped. Re-scanned at most once a minute |
| `FAL_DAILY_BUDGET_USD` | `20` | daily cap on the **reserve**: $0.25 per video second (min 5 s) per batch (H3 Max ~$0.085/s + input tokens ≈ $0.22/s, rounded up). A batch that would exceed it is refused (no fal call); nothing is queued when even a 5 s batch no longer fits |
| `ONDEMAND_MAX_QUEUE` | `30` | signs waiting at most; more are not queued |
| `PUPPET_RENDER` | `puppet/render.mjs` | renderer script (needs `puppet/node_modules` + the VRM in `puppet/models/`) |
| `ONDEMAND_NEUTRAL` | `out/realtime/neutral.clean.json` (or the main checkout's) | the shared neutral pose every clip starts and ends in |
| `ONDEMAND_AVATAR` | `assets/avatar/avatar-main.jpg` | Recast reference image (same as the existing clips) |
| `ONDEMAND_CLIPS_DIR` | `out/realtime/clips-ondemand` | generated clips + manifest; appended after `CLIPS_DIR`'s dirs (a configured clip always wins) |
| `ONDEMAND_STATE_DIR` | `out/ondemand` | `state.json` (queue, per-day spend, last 50 batches with timings) and `batches/<id>/` work files |

`GET /api/ondemand`: `{enabled, queued, running, done_today, spent_today_est, budget_usd, max_queue, motion_signs, items: [{motion_id, gloss, status: queued|running|done|failed, attempts, code?, reason?, eta_s?}], batches: [{id, signs, status, frames, seconds, reserve_usd, request_id, timings_s: {compose, render, fal, cut, reload}, total_s}]}`. `health.ondemand` = `{enabled, queued, running, done_today, spent_today_est}` (omitted unless `ONDEMAND` is set). Tests inject fake pipeline steps (`node --test test/ondemand.test.mjs`); under `node --test` the environment never enables it.
