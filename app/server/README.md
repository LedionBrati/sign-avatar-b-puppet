# app/server: SIGNLAYER local API (contract: `app/core/src/api.ts`)

`cd translate && npm i` once, then `node app/server/index.mjs` (binds 0.0.0.0, `PORT` default 8787, prints local + LAN URLs). No dependencies of its own; `npm test` here runs `node --test test/`.
`CLIPS_DIR=dirA,dirB` merges clip sets (`manifest.json` each; first dir wins on a motion_id); only manifest files that exist are served, at `/clips/<file>` with Range/206. `SEMANTIC=0` = rules only.
With the mass clip set (`pipeline/mass/`, see `experiments/2026-11-15-mass-signs.md`), run from the repo root with `CLIPS_DIR=out/realtime/clips,out/realtime/clips-mass node app/server/index.mjs`: the hand-made set wins on overlap, and mass aliases (synonyms sharing one WLASL video) point at the same file.
Routes: `GET /api/health`, `GET /api/vocab`, `POST /api/sign {text, semantic?}` (text ≤ 500 chars; errors are `{error:{code,message}}`), `GET /api/sign.mp4?text=` (joined mp4 via ffmpeg). CORS open to any origin.
The semantic model warms in the background (~0.5 s with `translate/cache/`); until `health.semantic` is `"ready"`, `/api/sign` uses rules only. `word_index` comes from the translator's `source_index`.
Sign -> voice: `POST /api/recognize?mode=sign|spell` (float32 body `frames x 543 x 3`, header `X-Frames`, max 384 frames) is proxied to `app/recognizer` at `RECOGNIZER_URL` (default `http://127.0.0.1:8788`); `503 recognizer_down` if it is not running, and `health.recognizer` is `"ready"` or `"down"`. Bodies are never logged (face points are biometric).
`GET /app/*` serves the built web app from `app/web/dist` (or `WEB_DIST`) with SPA fallback to `index.html`; `404 no_web_build` until it is built. Build the web app with a relative or `/app/` base so its assets resolve under `/app/`.

# Playback safety

The server evaluates every translator plan against the loaded clips before returning a signing playlist. See [the safety API and client handoff](../../docs/semantic-safety.md). Blocked or ambiguous messages have an empty playlist and retain the exact original caption; `/api/sign.mp4` returns HTTP 422 for them.
