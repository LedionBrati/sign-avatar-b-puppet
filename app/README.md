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
| `server/` | Local API: `POST /api/sign` (text → playlist), `GET /api/vocab`, `/clips/*` | Node, `translate/`, `pipeline/lib/clips.mjs` |
| `web/` | Web app, installable as a PWA. Home ("Tap to listen") and the live screen | Vite + React, Web Speech API |
| `extension/` | Chrome extension: a draggable signer in the corner of any page, S/M/L, captions. Signs selected text or the mic | WXT (Manifest V3) |
| `mobile/` | Phone app: same screens as the web app | Expo (React Native), `expo-speech-recognition`, `expo-video` |

## Real time

- **Translating:** about 0.2 ms with rules only, 5–25 ms with the local embeddings (`translate/`).
- **Playback:** the clips play back to back, so nothing is generated per request. A word without a clip shows as "can't sign yet" and is never invented.
- **Adding a sign** is offline work: puppet render + H3 Max, about 11 s of fal time per sign, once. See `experiments/2026-11-15-sentences-and-benchmarks.md` and `experiments/2026-11-15-demo-vocab.md`.

## Run

```bash
node app/server/index.mjs                         # http://localhost:8787 (CLIPS_DIR defaults to out/realtime/clips)
cd app/web && npm i && npm run dev                # web app
cd app/extension && npm i && npm run dev          # Chrome extension (WXT opens a browser)
cd app/mobile && npm i && npx expo start          # phone: set the server URL to http://<LAN-IP>:8787
```

**Data:** the clips come from WLASL signers repainted by H3 Max. That's non-commercial research data, so this is for private demos only (README §13).
