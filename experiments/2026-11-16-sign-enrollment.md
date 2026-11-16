# 2026-11-16: Sign -> voice for the demo: shared segmenter, closed vocabulary, "Train my signs"

**Who:** Nikos (with Claude, agent D)
**Question:** Can live sign -> voice be made reliable for the 20 demo signs: cut continuous signing into the right pieces, read them with a closed-vocabulary model that can learn the presenter's own signing, and say "not sure" instead of a wrong word? And would another landmark extractor help?
**Why it matters:** Isolated clips were fine (86% top-1), live signing was not: the old segmenter cut the wrong windows and the open 250-sign model picked wrong words.

## Setup
- Demo signs: HELLO YES NO PLEASE THANK_YOU WATER HUNGRY SICK HOME HELP NAME NICE MEET YOU ME (+ I) WHERE FINE HAPPY BYE (+ GOODBYE) SORRY. All 20 have data.
- Data, no human signer: `fetch_wlasl_demo.py` downloaded the direct (non-YouTube) WLASL_v0.3 links of these glosses: 89 of 194 worked (handspeak, signingsavvy, aslsignbank, aslsearch are dead or blocked; skipped). Plus the library clip of each gloss and 3 extra instances = **92 clips, 29 signers, 2-7 per sign**. Open-set negatives: 400 other WLASL glosses from the motion library (200 train the "none" class, 200 test).
- Landmarks: MediaPipe Holistic (Python, same model as the web app), cached in `out/wlasl-demo/` (gitignored).
- Segmenter: `app/core/src/segment.ts` = `app/recognizer/segment.py` (shared fixture test). Hand up / rest with hysteresis, motion over 3 frames, rest 140 ms / gone 350 ms / hold 260 ms, min 300 ms, min travel, "mostly downward" = hands going to rest (dropped), max 3.5 s cut at the slowest moment. `personal.decode` splits long segments at speed valleys when 2+ signs explain them better.
- Classifier: `personal.py`. Hand features (shoulder frame, wrist + 20 points + velocity, 24 frames), multinomial logistic regression (numpy, top 128 PCs), DTW to each sign's nearest template, GISLR prior; p ~ p_lr * g^0.75 * exp(-2 d). "None" class = other signs, transitions, idle hands, the person's own "no sign" rep.
- Leave-signer-out everywhere: the test signer is never in training. This is the honest lower bound for enrollment; with the presenter's own reps it should only get better (not measurable without a human).
- Commands: `eval_demo.py isolated`, `eval_demo.py continuous` (run before the laptop overheated; from now on through `modal_sign_eval.py`).

## Result
**Isolated, 92 clips, 20-sign vocabulary, leave-signer-out (29 folds):**

| | top-1 |
|---|---|
| main (GISLR + templates + client rules) | 67/92 = 73% |
| main's scores, demo signs only | 73/92 = 79% |
| GISLR only (demo signs) | 54/92 = 59% |
| logreg on GISLR's 250 outputs (embedding) | 65/92 = 71% |
| DTW 1-NN, hand features | 49/92 = 53% |
| logreg + DTW, hand features | 62/92 = 67% |
| **logreg + DTW + GISLR prior (chosen)** | **79/92 = 86%**; with the strict gate: 67% accepted, 97% right when accepted |
| same, 8x augmentation | 76/92 = 83% (so augmentation is off) |

A 1D-CNN / transformer was not tried: with 2-7 clips per sign it would overfit, and logistic regression already trains in seconds.

Open set (200 other WLASL signs): main said a demo word for 4% (it says some other word instead); the new model, demo signs only, accepted 26% as a demo sign. Inside the closed demo the realistic junk is transitions and fidgeting, which the none class targets; signing an unrelated word on stage will often come out as the nearest demo word (chips + Undo stay).

**Continuous, 60 pseudo-sentences (3-4 signs of one test signer, shoulders aligned, rest between signs), leave-signer-out:**

| | cuts P / R | sentences exactly right | word error rate |
|---|---|---|---|
| main: old segmenter + main recognizer | 87% / 90% | 11/60 = 18% | 44% |
| new segmenter + main recognizer | 93% / 92% | 26/60 = 43% | 29% |
| new segmenter + main scores, demo signs only | 93% / 92% | 30/60 = 50% | 24% |
| new segmenter + personal, strict gate (unsure dropped) | 93% / 92% | 6/60 = 10% | 43% |
| **new segmenter + personal, always top-1** | 93% / 92% | **30/60 = 50%** | **22%** |
| new segmenter + decoder + personal, always top-1 | 93% / 93% | 30/60 = 50% | 21% |

The strict gate dropped too many right words, so the app now drops only "no sign" (none class wins) and shows the rest with a "not sure" hint (`unsure`). The "pause" and "no pause" styles (signs joined by a short glide, no rest) did not finish before the stop; run them on Modal.

**Latency** (busy, hot laptop CPU): reading one piece (GISLR + personal) median 146 ms, p95 671 ms in-process. HTTP `/recognize` median 1.0 s with `profile=demo` vs 2.0 s for the open path, a 3-sign segment with the decoder 3.7 s (all inflated by two evals running at the same time). Training a profile: ~4-11 s per fold here.

**Extractor (RTMW whole-body, rtmlib lightweight, onnxruntime CPU):** 780 ms per frame on an idle-ish laptop, 1.9 s under load, so about 1 fps: it cannot run live on this CPU (MediaPipe Holistic in the browser runs at camera rate). It also has no face mesh, so GISLR loses its lip features. The accuracy comparison (`eval_demo.py extractor`) did not run (21 clips extracted); verdict: **not adopted**. MediaPipe "Python full model" is the same holistic_landmarker.task as the web app, so no gain there either.

## What I learned
- Most of the gain is segmentation (18% -> 43% sentences with the same recognizer) and restricting to the demo signs (-> 50%). The personal model matches that cross-signer and adds what enrollment brings for the presenter.
- Rejection is a trade: a strict "unsure" gate looks great on isolated clips (97% right when accepted) and kills continuous sentences.
- WLASL ends every sign with a hold and then a drop to rest; without the "mostly downward" rule every sign came out as two.

## What I'd try next
- Run the "pause" / "no pause" styles and the RTMW comparison on Modal (`modal_sign_eval.py`).
- A real check with the presenter: 4 reps per sign, then 10 demo sentences, count words right.

**Data:** WLASL (C-UDA, research use only), private eval only. Landmarks stay in gitignored `out/`; enrollment stores hands + pose only, no face.
