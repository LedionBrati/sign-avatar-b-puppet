# 2026-11-15: Sign -> voice recognizer service (pretrained, no training)

**Who:** Nikos (with Claude)
**Question:** Do the two pretrained Kaggle winners (GISLR isolated signs, ASL Fingerspelling) work behind our API on landmarks we extract ourselves, on signers they were never trained on, and how fast are they on a laptop CPU?
**Why it matters:** Sign -> voice is the second half of the product. If off-the-shelf models are good enough on clean clips, the work left is UX (chips, confirm, speak), not ML.

## Setup
- Service: `app/recognizer/` (Python 3.13, uv, `ai-edge-litert` 2.x, stdlib `ThreadingHTTPServer`, :8788), proxied by `app/server` at `POST /api/recognize?mode=sign|spell` (:8787). Contract: `RecognizeResponse` in `app/core/src/api.ts`.
- Models (`fetch_models.py`, gitignored `app/recognizer/models/`):
  - `sign`: GISLR 1st place (hoyso48), `huggingface.co/sign/kaggle-asl-signs-1st-place`, MIT. Input `[N, 543, 3]`, 250 logits, softmax top-5.
  - `spell`: ASL Fingerspelling 1st place (Henkel/Hanley), Apache-2.0, only `cfg_2/fold-1/model.tflite` (40.9 MB) + `inference_args.json` from the 192 MB release zip, read with HTTP Range requests (fetch from scratch: 14 s). Input `[N, 390]` (130 points x xyz, mapped from the 543 layout by column name). The tflite already greedy-decodes and cuts at EOS; we argmax each row and map with `character_to_prediction_index.json` (59 chars; P/S/E = 59/60/61). Its low-confidence fallback phrase `"2 a-e -aroe"` (a Kaggle-metric trick in `cfg_2.py`) becomes `""`. Spaces are dropped (spell mode = one word or name).
- Eval data: WLASL clips in the library (`ai-summit/data/signs/index.json`) whose gloss is in the GISLR vocabulary: 206 (201 exact + aliases thankyou, icecream, frenchfries, grandpa->grandfather, minemy->my). A seeded random 100 of them were evaluated (19 different signers). These are **not** GISLR training data (that was PopSign).
- Landmarks: MediaPipe Tasks `HolisticLandmarker` in Python (mediapipe 1.2.3, `holistic_landmarker.task`, VIDEO mode), packed exactly like `app/core/src/landmarks.ts` (478 -> 468 face, legacy order, NaN missing), unmirrored, trimmed to the frames where a hand is visible (what the web client's auto start/stop sends).
- Commands:
  ```sh
  cd app/recognizer && uv sync --all-groups && uv run python fetch_models.py
  uv run python server.py &                       # :8788
  PORT=8787 node app/server/index.mjs &           # proxy
  uv run --group eval python -m eval.eval_wlasl --limit 100 --url http://127.0.0.1:8787 --spell
  ```

## Result
**Isolated signs, end to end through the Node proxy, N = 100 WLASL clips:**

| | |
|---|---|
| top-1 | **86/100 = 86%** |
| top-5 | **96/100 = 96%** |
| segment length | median 36 frames (17–69) |
| top-1 confidence | median 0.93 when right, 0.31 when wrong. At confidence ≥ 0.7: 70 clips, 70/70 right |

Misses (label -> top-1): kiss->home, scissors->cut, make->zipper, fine->table, helicopter->police, dance->zebra, tooth->glasswindow, table->arm, after->table, there->vacuum, cry->for, ride->stairs, clean->zebra, tongue->glasswindow. 10 of the 14 still had the right sign in the top 5. This matches the earlier 60-clip check in `docs/product-plan.md` §3 (82% / 97%).

**Fingerspelling sanity (no proper test set on this machine):**
- 21 single-letter WLASL clips (the library has a b d e f g h i j k m n o p q r s t u v w): **20/21 exactly right** (Q read as S).
- Words made by concatenating those letter clips (different signers, so the hands jump between letters, which is harder than real spelling): BAD, DOG, MOM, HI, JAKE, MARIA all **6/6 right** after dropping spaces. Before dropping spaces the model gave `B A D`, `DO G`, `MARI A`, so it reads pauses as word breaks.
- This is a sanity check, not an accuracy number. Real continuous fingerspelling of names by real users is still untested.

**Latency** (12-core laptop CPU, no GPU, shared with other jobs; load 45–50% during every run, so expect lower on a quiet machine):

| | round trip median | p95 | model only (median) |
|---|---|---|---|
| sign, direct :8788 (30 real segments) | 62 ms | 120 ms | 39 ms |
| sign, via Node :8787 | 49 ms | 78 ms | 30 ms |
| sign, eval run 1 / run 2 (100 clips, via :8787) | 62 / 215 ms | 154 / 707 ms | 45 / 175 ms |
| spell, single letters (~40 frames) | 0.5–1.3 s | 2.2 s | ~0.5 s |
| spell, words (78–203 frames) | 1.3–2.3 s (quiet) up to 5.4 s (loaded) | | |

Spell latency grows with clip length and output length: the tflite runs the decoder up to 33 times with no KV cache. Synthetic 384-frame input: spell 11.6 s, sign 0.8 s. Model load + warm-up at startup: about 2 s on an idle machine.

Tests: `uv run pytest -q` (17 pass: shape validation, all-NaN segment, top-5 sorted and normalized, spell column mapping, decoding, HTTP). `node --test app/server/test/*.test.mjs` (20 pass including semantic: 7 new for the proxy, 503 when down, CORS X-Frames, `/app/` static + SPA fallback).

## What I learned
- The pretrained GISLR model generalizes from PopSign to WLASL signers we extract ourselves: 86% top-1 / 96% top-5 with no training. Top-5 chips plus a confirm step is the right UX: the right sign is almost always on screen.
- Confidence is informative. At ≥ 0.7 it was never wrong here, so the client could auto-pick the first chip above 0.7 and ask otherwise.
- The landmark packing in `landmarks.ts` (drop iris, legacy order, unmirrored) is correct: the same packing in Python gives these numbers. A mirrored feed would mix up left and right hands.
- Fingerspelling works on clean letters. It is slow on CPU (about 0.5 s per letter-length clip, seconds for long ones), so clients should keep spell segments short (≤ 4 s) and show a "reading…" state.

## What I'd try next
- Real webcam users (lighting, partial framing, left-handed signers). This is the real test, and WLASL clips are studio-clean.
- Cap or downsample long spell segments on the server, and measure accuracy against latency.
- A proper fingerspelling set (ChicagoFSWild, or the Kaggle supplemental data) for a real character error rate.
- Use GISLR to auto-check the motion dictionary (product plan §3 synergy): flag extracted signs the model no longer recognizes.

**Data:** WLASL (C-UDA, research use only) and Kaggle-derived models. Private demo only. No landmarks were committed or logged; the eval cache lives in `%TEMP%`.
