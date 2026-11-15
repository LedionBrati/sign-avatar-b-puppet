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
uv run pytest -q                         # 17 tests
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
  `text` for `options` uses the same label mapping as `labelText` in `app/core/src/compose.ts`. For `spell`, `text` is `""` when the model gives no reading (its built-in low-confidence/too-short fallback phrase `2 a-e -aroe` is mapped to empty) and `options` is then `[]`.
- Errors: `{error: {code, message}}` with `bad_frames`, `bad_body_size`, `too_many_frames` (413), `bad_mode`, `not_found`, `internal`.

**Privacy:** landmark bodies contain face points (biometric). The service never logs or stores them; the access log has method, path and status only.

## Evaluate

```bash
uv sync --group eval                                                   # + mediapipe 1.2.3 (Tasks HolisticLandmarker)
uv run --group eval python eval_wlasl.py --url http://127.0.0.1:8787 --spell   # through the Node proxy, all overlapping clips
```

Takes WLASL clips from the library (`C:\Users\DELL\Desktop\ai-summit\data\signs\index.json`) whose gloss is in the GISLR vocabulary, extracts landmarks with the Python HolisticLandmarker (VIDEO mode, 478 -> 468 face packing, hands window like the web client), posts them over HTTP and reports top-1/top-5 and latency. Landmark caches go to `%TEMP%/signlayer-eval-cache`, never the repo. Results: `experiments/2026-11-15-sign-recognizer.md`.

## Files

`recognizer.py` (models, validation, spell column mapping, decoding) · `server.py` (HTTP) · `fetch_models.py` · `eval_wlasl.py` · `tests/`
