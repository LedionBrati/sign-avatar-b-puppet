# SIGNLAYER apps

The product shell for Method B: **hear anything, see it signed.** The design follows the team's SIGNLAYER prototypes: a grainy cobalt background, frosted-glass cards, captions that light up word by word, one card per speaker.

```
speech (on the device) ──► text ──► app/server ──► playlist of realistic sign clips ──► client plays them back to back
                                     │  translate/ (no LLM, rules + local embeddings)
                                     └  clips/manifest.json (pre-rendered H3 Max clips, one per sign, all starting and ending in one neutral pose)
```

| Folder | What | Stack |
|---|---|---|
| `core/` | API contract, client, caption word states, design tokens. Shared by everything | TypeScript, no dependencies |
| `server/` | Local API: `POST /api/sign` (text → playlist), `GET /api/vocab`, `/clips/*`, `POST /api/recognize` (proxy), `/app/*` (built web app) | Node, `translate/`, `pipeline/lib/clips.mjs` |
| `recognizer/` | Sign → voice: pretrained GISLR (250 isolated signs) + ASL fingerspelling models, `POST /recognize` on :8788 | Python 3.13, uv, `ai-edge-litert` |
| `web/` | Web app, installable as a PWA. Home ("Tap to listen"), the live screen, and Sign to speak (`#/sign`: camera → MediaPipe Holistic → `/api/recognize` → spoken sentence) | Vite + React, Web Speech API, MediaPipe tasks-vision |
| `extension/` | Chrome extension: a draggable signer in the corner of any page, S/M/L, captions. Signs selected text or the mic | WXT (Manifest V3) |
| `mobile/` | Phone app: same screens as the web app | Expo (React Native), `expo-speech-recognition`, `expo-video` |

## Real time

- **Translating:** about 0.2 ms with rules only, 5–25 ms with the local embeddings (`translate/`).
- **Playback:** the clips play back to back, so nothing is generated per request. A word without a clip shows as "can't sign yet" and is never invented.
- **Adding a sign** is offline work: puppet render + H3 Max, about 11 s of fal time per sign, once. See `experiments/2026-11-15-sentences-and-benchmarks.md` and `experiments/2026-11-15-demo-vocab.md`.

## Sign → voice

```
camera (on the device) ──► HolisticLandmarker ──► 543 points/frame (landmarks.ts) ──► POST /api/recognize?mode=sign|spell
                                                                                      │ app/server proxies to app/recognizer (:8788)
top-5 sign chips / spelled word ◄── RecognizeResponse ◄──────────────────────────────┘
        └► composeSentence() (core/compose.ts, no LLM) ──► the signer confirms ──► speechSynthesis
```

- Only points leave the device, never video. Points include the face (biometric), so neither service logs them.
- Measured on WLASL clips the model never saw: see `experiments/2026-11-15-sign-recognizer.md` (top-1/top-5, latency, fingerspelling status).
- Phones load the built web app from the API: `http://<LAN-IP>:8787/app/#/sign?embed=1` (needs `app/web/dist`, or point `WEB_DIST` at a build).

## Run

```bash
(cd translate && npm i)                           # once: translator deps (local embeddings model)
node app/server/index.mjs                         # http://localhost:8787 + LAN URL; CLIPS_DIR=dirA,dirB (default out/realtime/clips)
(cd app/recognizer && uv sync && uv run python fetch_models.py && uv run python server.py)   # sign -> voice on :8788 (RECOGNIZER_URL for the API)
node app/start.mjs                                # or both of the above in one terminal (recognizer + API)
(cd app/web && npm run build)                     # then the API serves it at /app/
cd app/web && npm i && npm run dev                # web app
cd app/extension && npm i && npm run dev          # Chrome extension (WXT opens a browser)
cd app/mobile && npm i && npx expo start          # phone: set the server URL to http://<LAN-IP>:8787
```

**Data:** the clips come from WLASL signers repainted by H3 Max. That's non-commercial research data, so this is for private demos only (README §13).
