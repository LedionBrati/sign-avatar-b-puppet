# app/server: SIGNLAYER local API (contract: `app/core/src/api.ts`)

`cd translate && npm i` once, then `node app/server/index.mjs` (binds 0.0.0.0, `PORT` default 8787, prints local + LAN URLs). No dependencies of its own; `npm test` here runs `node --test test/`.
`CLIPS_DIR=dirA,dirB` merges clip sets (`manifest.json` each; first dir wins on a motion_id); only manifest files that exist are served, at `/clips/<file>` with Range/206. `SEMANTIC=0` = rules only.
Routes: `GET /api/health`, `GET /api/vocab`, `POST /api/sign {text, semantic?}` (text ≤ 500 chars; errors are `{error:{code,message}}`), `GET /api/sign.mp4?text=` (joined mp4 via ffmpeg). CORS open to any origin.
The semantic model warms in the background (~0.5 s with `translate/cache/`); until `health.semantic` is `"ready"`, `/api/sign` uses rules only. `word_index` comes from the translator's `source_index`.
