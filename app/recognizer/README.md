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
uv run pytest -q                         # 42 tests
```

Environment (all optional): `RECOGNIZER_HOST` (`127.0.0.1`), `RECOGNIZER_PORT` (`8788`), `RECOGNIZER_MODELS`
(`app/recognizer/models`), `ENROLL_DIR` (`<repo>/out/enroll`), `TEMPLATES` (`on`; `off` = GISLR only), `KID_PRIOR`
(`0.35`), `MOTION_MIN` (`0.025`), `REJECT_CONF` (`0.2`), `PERSONAL_REJECT` (`0.6`), `PERSONAL_DTW_FAR` (`1.0`),
`PERSONAL_REJ_DTW` / `PERSONAL_REJ_T` (`0`, off), `RECOG_DEBUG=1` (log top labels per answer, never landmarks),
`OPENBLAS_NUM_THREADS` / `OMP_NUM_THREADS` (`4` unless set). `fetch_models.py --from DIR` copies files you already have (`gislr.tflite`/`islr.tflite`, `map.json`, `fs.tflite`, `fs_args.json`).

Everything at once from the repo root: `node app/start.mjs` (this service + the Node API on :8787).

### Runtime files (`models/`, gitignored)

| File | Size | Needed | From |
|---|---|---|---|
| `gislr.tflite`, `gislr_labels.json` | 11.2 MB, 3 KB | required | `fetch_models.py` (Hugging Face) |
| `fs.tflite`, `fs_args.json`, `fs_chars.json` | 40.9 MB, 6 KB, 0.4 KB | required | `fetch_models.py` (GitHub release, HTTP Range) |
| `templates.npz` | 1.5 MB | optional | `eval/build_templates.py` (needs extracted WLASL motion `out/motion/wlasl`, the WLASL library `index.json` and the clip manifests `out/realtime/clips*`) |
| `demo_model.npz` | 0.4 MB | optional | `eval/build_demo_model.py` (needs `out/wlasl-demo` from `eval/fetch_wlasl_demo.py --extract` + the motion library) |
| `demo_generic.npz` | 1.8 MB | optional | `eval/build_demo_model.py`, same run |

The three optional files are derived features only (no landmarks), but they come from WLASL (research use only), so
they are not downloadable from upstream; ship them separately or rebuild them. Without a required file `server.py`
exits with one line telling you to run `fetch_models.py`. Without an optional one it starts anyway and prints one
`recognizer: optional models missing ...` line: no `templates.npz` = GISLR's 250 signs only; no `demo_model.npz` =
`profile=demo` / `vocab=` requests are answered like plain sign mode (no `signs`); no `demo_generic.npz` = "Train my
signs" fits on the person's own reps only.

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
uv run python -m eval.build_templates --index <path-to>/index.json   # rebuild models/templates.npz (~1.4 MB, gitignored, ~10-90 s)
uv run python -m eval.build_templates --eval-only --gislr            # leave-one-out check, also merged with GISLR
```

Motion comes from `--motion` / `MOTION_DIR` (default `out/motion/wlasl`, see `motion/batch_library.py`); glosses from the clip manifests in `CLIPS_DIR` (default `out/realtime/clips*`).

Leave-one-out on the 13 glosses with 2+ extracted instances (44 queries, each matched against the bank without
itself, from the raw json converted to the 543 x 3 layout the server receives; different signers): templates
**top-1 48% / top-5 64%**; merged with GISLR **52% / 61%**. The specific held-out alternates: `all-a1` rank 2
(merged rank 1), `have-a1` and `have-a3` rank 1, `nice-a2` missed. This is one WLASL example per sign, so expect
it to work best for distinctive signs and to need the confirm chips otherwise. Glosses without extracted motion
(BELIEF, CAREFUL, COP, DURING, EXPECT, HOST, LOCAL, MEANING, PAST, POTENTIAL, REALIZE, SHARE, SIMILAR, TALE, TRUE) are not in the bank.

## Demo vocabulary + "Train my signs" (closed vocabulary, personal model)

For the finals the web app reads only the 20 demo signs (HELLO YES NO PLEASE THANK_YOU WATER HUNGRY SICK HOME HELP
NAME NICE MEET YOU ME WHERE FINE HAPPY BYE SORRY), with a model that can learn the presenter's own signing.

- `segment.py` (mirror of `app/core/src/segment.ts`, same numbers, a shared fixture test keeps them equal): cuts
  continuous signing into signs. Hand up / rest with hysteresis, motion energy over 3 frames (jitter does not count),
  ends on rest / hands gone / a 260 ms hold, 300 ms minimum, the hands going back down is not a sign, 3.5 s maximum
  (cut at the slowest moment).
- `personal.py`: per-segment hand features (shoulder frame, 24 frames), multinomial logistic regression (numpy, on
  the top 128 principal components) + DTW distance to each sign's nearest template + the GISLR prior, only over the
  active vocabulary. A "none" class (other WLASL signs, transitions between signs, idle hands, the person's own "no
  sign" rep) gives `reject` (no sign, dropped); fused top-1 < 0.6 or DTW > 1.0 gives `unsure` (kept, with a hint).
  `decode()` splits a long segment at speed valleys when two or more signs explain it better than one.
- `enroll.py`: reps stored in `out/enroll/<profile>/<LABEL>/*.npy` (gitignored, **hands + pose only, the face is
  removed**), `model.npz` per profile; training adds the reps (weight 3) to the generic WLASL data, ~2-5 s on CPU.
- `eval/build_demo_model.py`: the generic data and model (`models/demo_generic.npz`, `models/demo_model.npz`, derived
  features only) from WLASL clips of the demo signs; profile `demo` uses it before anyone enrolls.

```bash
uv run --group eval python -m eval.fetch_wlasl_demo --wlasl <path-to>/WLASL_v0.3.json --extract   # 89 more clips, ~25 min CPU, out/wlasl-demo/
uv run python -m eval.build_demo_model                                                # ~15 s
uv run python -m eval.eval_demo all                                                   # isolated + continuous: heavy, use Modal
modal run app/recognizer/eval/modal_sign_eval.py::upload --signs-dir <signs>         # from the repo root, then:
modal run app/recognizer/eval/modal_sign_eval.py --jobs isolated,continuous,rtmw
```

Routes (proxied by app/server under `/api/...`): `POST /recognize?mode=sign&profile=P&vocab=A,B` (+ `X-Fps`) answers
with `signs: [{start, end, options, reject}]`; `GET|POST|DELETE /enroll?profile=P[&label=L]`, `POST /train?profile=P`,
`GET /profiles`. Without `profile` the sign path is unchanged. Results: `experiments/2026-11-16-sign-enrollment.md`.

## Evaluate

```bash
uv sync --group eval                                                   # + mediapipe 1.2.3 (Tasks HolisticLandmarker)
uv run --group eval python -m eval.eval_wlasl --url http://127.0.0.1:8787 --spell   # through the Node proxy, all overlapping clips
```

Takes WLASL clips from the library (`--lib <path-to>/signs` or `SIGN_DICTIONARY=<path-to>/index.json`) whose gloss is in the GISLR vocabulary, extracts landmarks with the Python HolisticLandmarker (VIDEO mode, 478 -> 468 face packing, hands window like the web client), posts them over HTTP and reports top-1/top-5 and latency. Landmark caches go to `%TEMP%/flux-eval-cache`, never the repo. Results: `experiments/2026-11-15-sign-recognizer.md`.

## Files

Service: `server.py` (HTTP) · `recognizer.py` (models, validation, spell column mapping,
decoding) · `templates.py` · `enroll.py` · `personal.py` · `segment.py` · `context.py` (mirror of app/core's, used by
the evals and tests) · `fetch_models.py` · `tests/`.

Research, eval and data scripts live in `eval/` (a package; nothing in the service imports it). Run them as modules
from `app/recognizer`, e.g. `uv run python -m eval.eval_demo isolated`, so the service modules import as usual:

| Script | Does |
|---|---|
| `eval/build_templates.py` | builds `models/templates.npz` (runtime, optional) from extracted WLASL motion |
| `eval/build_demo_model.py` | builds `models/demo_generic.npz` + `models/demo_model.npz` (runtime, optional) from `out/wlasl-demo` + the motion library |
| `eval/demo_data.py` | loads the demo-vocabulary eval clips (shared by the scripts below) |
| `eval/fetch_wlasl_demo.py` | downloads more WLASL instances of the demo signs into `out/wlasl-demo/` (`--extract`: landmarks) |
| `eval/gather_wlasl.py` | the bigger WLASL gather for `eval_generic.py` (runs on Modal) |
| `eval/eval_wlasl.py` | GISLR top-1/top-5 over HTTP on WLASL clips (`--group eval`) |
| `eval/eval_demo.py`, `eval/eval_continuous.py`, `eval/eval_generic.py` | closed-vocabulary / continuous / generic-model evals |
| `eval/extract_rtmw.py` | RTMW whole-body landmarks for the extractor comparison (own venv) |
| `eval/modal_sign_eval.py` | runs the heavy ones on Modal |
