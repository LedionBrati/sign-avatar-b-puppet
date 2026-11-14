# Product plan: Method B as a two-way ASL app

**Who:** Nikos · **Date:** 14 Nov 2026 · **Status:** proposal (open for comments, nothing assigned)

This plan fits work done in a separate repo (`ai-summit`: a two-way English ↔ ASL app plan, a 1,945-sign library, an adversarial review) onto this repo's Method B. **Where the README already decides something, the README wins.** Where it leaves a choice open, this plan keeps what was decided in `ai-summit`, marked **(kept)**.

---

## 1. Goal

Same vision as README §1, built in this order:

1. **Localhost app (README §6.9):** type a sentence → a realistic avatar signs it, with the gloss and the puppet shown next to it.
2. **Speech in:** the hearing person speaks instead of typing.
3. **Sign → speech:** the Deaf person signs, and the app speaks it.
4. **Surfaces:** a web app installable on phones (PWA), and a Chrome extension (side panel plus "Sign this" on selected text).

The rules are README §13, unchanged. The AI never invents signs, no real faces, non-commercial data stays in private demos only, and Deaf signers decide what's correct.

---

## 2. Speech → sign: Method B pipeline

```
English ─► Claude gloss (closed vocab) ─► motion lookup ─► blend ─► puppet render ─► AI repaint ─► finish ─► video
                                                              └──► puppet preview in the browser (instant)
```

| Step | Choice | Source |
|---|---|---|
| Avatar | The AI woman in `assets/avatar/`. Framing 3:4 at 540×720, 24 fps, waist up | README decision |
| Motion source (isolated signs) | **WLASL, 1,945 signs** already downloaded and normalised to H.264 by a builder script in `ai-summit`. Licence C-UDA (non-commercial), the same class as How2Sign, so fine for private demos | (kept) |
| Motion source (sentences, quality target) | How2Sign clips in `references/`, plus `judy-avatar-clean.mp4` as the target | README |
| Point extraction | MediaPipe HolisticLandmarker in Python (`mediapipe` 1.2.3 has Windows wheels, verified). Option to compare later: SignAvatars' SMPL-X 3D fits for WLASL, which may have better fingers (needs their request form) | README §6.2 + (kept) |
| Cleanup | One Euro smoothing, refilling lost hands, trimming to rest pose, **mirroring left-handed signers** (WLASL has 30 signers, some left-dominant) | README §6.2 + adversarial review |
| Motion format | One JSON per sign: `{gloss, fps, frames:[{pose, poseWorld, face, leftHand, rightHand}], meta:{source, signer, licence, start, end, dominantHand}}`. Start from `gsl-pharmacy-bridge`'s `shared/types.ts` once we have access | README §6.7 |
| Gloss | Claude with a closed vocabulary from the motion dictionary. Never-invent enforced in code (an unknown gloss becomes a caption). Output marks fingerspelling as `fs:MARIA` and questions as `Q`. Ambiguous English labels get **sense notes** (right, can, bank, light, fine, left, …) | README §6.5 + (kept) |
| Blending | About 0.2 s overlap, slerp for rotations, easing for positions, rest pose skipped between signs. **Written once in TypeScript** so the browser preview and the server render use the same code | README §6.3 |
| Puppet | three.js + `@pixiv/three-vrm` + kalidokit (the GSL repo's approach). Compare against a **skeleton video** in E0. Rendered at the avatar framing | README §6.4 |
| Puppet render for repaint | Headless Chrome runs the same player page and records an mp4 | README (headless Chrome already used) |
| Repaint | **Race the candidates on puppet video** (E0): `minimax/h3-max/recast` (the quality target), `fal-ai/kling-video/v3/standard/motion-control` (newest Kling; takes the background from the avatar image, which skips background removal), `fal-ai/one-to-all-animation/14b` (**its fal page returned 404 when checked on 14 Nov 2026, so confirm it still exists first**), `fal-ai/bytedance/dreamactor/v2` (cheap) | README §6.1 + (kept: Kling v3 Standard) |
| Finish | The team scripts: `remove-bg.mjs`, `composite.sh`, `render-layers.mjs`, `build-videos.sh`. Needed for Recast only; Kling keeps the wall from the avatar image | README §10 |

**Two lessons from `ai-summit` that apply here:**
- **The puppet preview is the instant answer.** The repaint takes minutes (Recast measured 1.5–3 min), but the puppet plays in the browser in seconds. The UI shows the puppet right away and swaps in the avatar when the repaint lands, which also helps debugging (README §6.9).
- **Cost per sentence is real.** Recast costs $0.085/s at 768P (plus input tokens) with a 5 s minimum. Kling v3 Standard costs $0.126/s. A typical 6-sign sentence is about 9–13 s, so roughly $1–2 per new sentence. Sentences rarely repeat, so caching helps little. Repaint stays a button press, not automatic, until we know whether a live model (README §6.8) works.

### Baseline worth racing: B0
Before any puppet exists, **stitch the real WLASL clips for a sentence** (normalised framing, left-handed clips mirrored, idle frames trimmed) and repaint that video directly with Recast or Kling. That's the `ai-summit` approach. It needs no motion data, so it's a cheap baseline that shows how much the puppet is actually worth. It's also close to what Method A could do, so share the result there.

---

## 3. Sign → speech (kept from `ai-summit`)

README §1 lists this as a later idea. The plan keeps it, using **pretrained** models only, no training:

| Part | Choice |
|---|---|
| Points | `@mediapipe/tasks-vision` HolisticLandmarker in the browser, remapped from 478 face points to the legacy 468, giving the 543-point layout. Only points leave the device, never video. Points are never logged, because face points count as biometric data |
| Signs | GISLR 1st-place model (`huggingface.co/sign/kaggle-asl-signs-1st-place`, MIT licence, 250 signs). Trained on PopSign data (CC BY 4.0, 47 Deaf signers) |
| Fingerspelling | Kaggle ASL Fingerspelling 1st-place model (Henkel/Hanley, Apache-2.0), using only `cfg_2/fold-1/model.tflite` |
| Runtime | `ai-edge-litert` on the server (Windows and Python 3.13 wheels verified) |
| Interaction | Tap once; recording auto-stops when the hands rest or leave the frame (4 s maximum). A Sign/Spell toggle. Top-3 chips → Claude writes the sentence → the user confirms → `speechSynthesis` speaks it |
| Measured on clean WLASL clips | 82% top-1 and 97% top-5 on 60 clips. Real webcam users are still untested |

**Synergy with Method B:** the motion dictionary and the recognizer share one point format. The GISLR model can therefore **auto-check the motion dictionary** for the 201 signs both vocabularies have, flagging extractions that the model no longer recognises. That's README §6.2's "check each sign automatically" for free.

---

## 4. App and surfaces (kept from `ai-summit`; the README says "any stack")

| Part | Choice |
|---|---|
| API | Python FastAPI, in one container with ffmpeg, LiteRT and Node (for headless Chrome renders and the fal scripts) |
| Speech-to-text | **Server-side** via fal Whisper, because iOS home-screen web apps silently return nothing from `webkitSpeechRecognition` (WebKit bug 225298) |
| Web | Vite + React + TypeScript, installable as a PWA. Screens: Type/Speak → Sign (gloss + puppet + avatar), and Sign → Speak |
| Extension | WXT (Manifest V3). Speech → sign only in v1. Side panel, context menu, a one-time mic-permission tab, and a pinned extension ID |
| Access | Invite code plus a daily fal budget cap. Private demo only, per README §13 licences |

**Repo additions:**
- `motion/`: Python extraction, cleanup, QA.
- `puppet/`: TS blending and player, plus the headless render.
- `repaint/`: fal model wrappers, reusing `pipeline/lib/fal.mjs`.
- `app/api/`, `app/web/`, `app/extension/`.
- `recognize/`: pretrained models.

**Existing code to port from `ai-summit`:**
- The WLASL library builder.
- The Claude gloss prompt and its never-invent check.
- The fal queue client with timeouts.
- The shared TypeScript API contract.

---

## 5. Experiments, in order (each gets a log in `experiments/`)

| # | Question | Gate |
|---|---|---|
| **E0 repaint test** (README §6.1, about $5–10) | Take `judy.mp4`, extract its points, render a skeleton video and a simple VRM figure, then repaint each with Recast, Kling v3 Standard, and one-to-all (if it still exists). Compare with `judy-avatar-clean.mp4`. Also run **B0** on 3 stitched WLASL signs | Does any model keep handshapes from a puppet? **If not, Method B is blocked**, and B0/Method A carry the product |
| **E1 motion dictionary** | Extract and clean all 1,945 WLASL signs. Run the GISLR auto-check on the 201 overlapping signs | Share of signs that pass the auto-check |
| **E2 blend + puppet** | The 3 race sentences (README §4) rendered as puppet videos | A signer can read the puppet |
| **E3 gloss** | 20 test sentences, checked by a signer, covering `fs:` and `Q` markers and homographs | Wrong-sense and fallback rates |
| **M1 localhost app** | Text → gloss → puppet preview → repaint on button press → finish | The README §4 race, scored with its rubric |
| **M2 speech in** | Server-side speech-to-text | Works in iOS Safari and as an installed PWA |
| **M3 sign → speech** | Recognizer in the app | 3–5 real people signing 30 signs: top-5 ≥ 70% at ≥ 15 fps on a mid-range Android |
| **M4 PWA + extension** | Packaging | Private demo |

**Fingerspelling motion (A–Z) is missing.** WLASL has no clean alphabet, and race sentence 1 (`M-A-R-I-A`) needs one. It should be recorded by a fluent signer with good light at 60 fps. Using the GSL repo's `recorder/` once we have access would take about an hour.

---

## 6. Open items

1. **Access:** `LedionBrati/sign-avatar-a-stitching` and `fourlhs/gsl-pharmacy-bridge` are not visible to `fourlhs` on GitHub (14 Nov). The GSL repo's recorder, VRM player and clip format would save a lot of puppet work.
2. **A fluent signer** for A–Z recordings and for every "is it correct" check (README §13).
3. **`FAL_KEY` and `ANTHROPIC_API_KEY`** for E0 and E3.
4. **Decisions to add to the README table once agreed:** WLASL as the isolated-sign source; the repaint candidate list for E0; the sign → speech approach.
