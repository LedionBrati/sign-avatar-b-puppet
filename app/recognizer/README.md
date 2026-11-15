# app/recognizer: sign -> voice recognizer service

Two **pretrained** Kaggle models (no training), TFLite on CPU via `ai-edge-litert`, behind a small stdlib HTTP server on **:8788**. The Node API (`app/server`) proxies `POST /api/recognize` here, so clients never talk to this port directly.

| Mode | Model | Licence | In | Out |
|---|---|---|---|---|
| `sign` | GISLR 1st place (hoyso48), [`sign/kaggle-asl-signs-1st-place`](https://huggingface.co/sign/kaggle-asl-signs-1st-place) | MIT (trained on PopSign, CC BY 4.0) | `[N, 543, 3]` | 250 logits -> softmax top-5 |
| `spell` | ASL Fingerspelling 1st place (Henkel/Hanley), `cfg_2/fold-1/model.tflite` from the [v0.0.1-alpha release](https://github.com/ChristofHenkel/kaggle-asl-fingerspelling-1st-place-solution) | Apache-2.0 | `[N, 390]` (130 points x xyz, `inference_args.json`) | token scores already greedy-decoded and cut at EOS -> argmax -> characters |

Input is the legacy MediaPipe Holistic layout from `app/core/src/landmarks.ts`: float32 `[frames x 543 x 3]`, face 0-467 | left hand 468-488 | pose 489-521 | right hand 522-542, NaN = missing, unmirrored, at most 384 frames.

## Run

```bash
cd app/recognizer
uv sync                                  # ai-edge-litert + numpy (Python 3.13, Windows wheels OK)
uv run python fetch_models.py            # ~52 MB into models/ (gitignored); reads only 2 members of the 192 MB zip via HTTP Range
uv run python server.py                  # http://127.0.0.1:8788, loads + warms both models (~2 s)
uv run pytest -q                         # 25 tests
```

`RECOGNIZER_PORT` / `RECOGNIZER_HOST` (default `127.0.0.1`), `RECOGNIZER_MODELS` (models folder). `fetch_models.py --from DIR` copies files you already have (`gislr.tflite`/`islr.tflite`, `map.json`, `fs.tflite`, `fs_args.json`).

Everything at once from the repo root: `node app/start.mjs` (this service + the Node API on :8787).

## API

- `GET /health` -> `{ok, models: {sign, spell}, warm_ms}`
- `POST /recognize?mode=sign|spell` (also `/api/recognize`), body = raw little-endian float32, header `X-Frames: <frames>`.
  Body size must equal `frames * 543 * 3 * 4`; `frames` 1..384. Response = `RecognizeResponse`:
  ```json
  {"mode":"sign","options":[{"label":"thankyou","text":"thank you","confidence":0.83}, ...5],"frames":48,"timings":{"inference_ms":95.1,"total_ms":97.4}}
  {"mode":"spell","options":[{"label":"#MARIA","text":"MARIA","confidence":0.71}],"text":"MARIA","frames":90,"timings":{...}}
  ```
  `text` for `options` maps GISLR labels that are not plain words to adult-conversation text (`potty` -> "bathroom",
  `callonphone` -> "call", `minemy` -> "my", `weus` -> "we", `hesheit` -> "he", `yourself` -> "you", `haveto` -> "have to",
  `thankyou` -> "thank you", `glasswindow` -> "window", ...); labels are unchanged.
  Sign mode also returns `motion` (mean frame-to-frame displacement of wrists + fingertips, in shoulder widths; real
  signs ~0.07+, a held pose with tracking jitter ~0.015-0.03) and `reject: true` when `motion < MOTION_MIN` (0.025) or
  the best confidence is below `REJECT_CONF` (0.2): probably no sign / a transition. Options are still returned.
  GISLR confidences for 39 toddler-vocabulary labels (animal, zebra, puppy, balloon, ...; `KID_LABELS`) are scaled by
  `KID_PRIOR` (0.35; `KID_PRIOR=1.0` disables) before ranking and merging. For `spell`, `text` is `""` when the model gives no reading (its built-in low-confidence/too-short fallback phrase `2 a-e -aroe` is mapped to empty) and `options` is then `[]`.
- Errors: `{error: {code, message}}` with `bad_frames`, `bad_body_size`, `too_many_frames` (413), `bad_mode`, `not_found`, `internal`.

**Privacy:** landmark bodies contain face points (biometric). The service never logs or stores them; the access log has method, path and status only.

## Template matching (words GISLR lacks)

GISLR knows 250 kid-vocabulary signs, so most demo words (HOW, GOOD, EVENING, COMPANY, JUDGE, COFFEE, NICE, MEET, ...) are
missing. `templates.py` adds a **nearest-template** recognizer over the WLASL motion we already extracted (no new videos,
no training): **332 glosses / 363 templates** (every sign the avatar can sign from the realtime clip manifests + the demo
words, where motion exists; extra instances such as `all-a1/a3`, `have-a1..a3`, `nice-a1/a2`, `lucky-b1` are extra templates).

- Features per frame, per hand: wrist position in a shoulder frame (origin = shoulder midpoint, x / shoulder width,
  y / nose-to-shoulder height, so aspect ratio and distance cancel), 20 hand points relative to the wrist / hand size,
  wrist velocity. Rest frames at the start/end (both hands low) are trimmed; resampled to 32 frames. Templates are
  stored right-dominant; a left-handed query is mirrored (dominant hand = the one raised and moving more).
- Banded DTW (band 4) against every template, all vectorized in numpy: **~20-40 ms** for the whole bank on this laptop.
- Confidence: softmax over the 5 nearest glosses (the margin is what tells right from wrong) times a gate on the best
  distance. Merged with GISLR into one top-5 keyed by display text; GISLR confidences are scaled by 0.8 first because
  its softmax is overconfident outside its vocabulary. Template labels are glosses with underscores (`THANK_YOU`,
  text `thank you`), so `labelText` in app/core already reads them. Response format unchanged.
- `TEMPLATES=off` disables it (GISLR only). `/health` shows `gislr (250 signs) + wlasl templates (332 signs)`.

```bash
.venv/Scripts/python build_templates.py            # rebuild models/templates.npz (~1.4 MB, gitignored, ~10 s)
.venv/Scripts/python build_templates.py --eval-only --gislr   # leave-one-out check, also merged with GISLR
```

Leave-one-out on the 13 glosses with 2+ extracted instances (44 queries, each matched against the bank without
itself, from the raw json converted to the 543 x 3 layout the server receives; different signers): templates
**top-1 48% / top-5 64%**; merged with GISLR **52% / 61%**. The specific held-out alternates: `all-a1` rank 2
(merged rank 1), `have-a1` and `have-a3` rank 1, `nice-a2` missed. This is one WLASL example per sign, so expect
it to work best for distinctive signs and to need the confirm chips otherwise. Glosses without extracted motion
(BELIEF, CAREFUL, COP, DURING, EXPECT, HOST, LOCAL, MEANING, PAST, POTENTIAL, REALIZE, SHARE, SIMILAR, TALE, TRUE) are not in the bank.

## Evaluate

```bash
uv sync --group eval                                                   # + mediapipe 1.2.3 (Tasks HolisticLandmarker)
uv run --group eval python eval_wlasl.py --url http://127.0.0.1:8787 --spell   # through the Node proxy, all overlapping clips
```

Takes WLASL clips from the library (`C:\Users\DELL\Desktop\ai-summit\data\signs\index.json`) whose gloss is in the GISLR vocabulary, extracts landmarks with the Python HolisticLandmarker (VIDEO mode, 478 -> 468 face packing, hands window like the web client), posts them over HTTP and reports top-1/top-5 and latency. Landmark caches go to `%TEMP%/signlayer-eval-cache`, never the repo. Results: `experiments/2026-11-15-sign-recognizer.md`.

## Files

`recognizer.py` (models, validation, spell column mapping, decoding) · `server.py` (HTTP) · `fetch_models.py` · `eval_wlasl.py` · `tests/`
