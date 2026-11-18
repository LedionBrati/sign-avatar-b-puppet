# 2026-11-15: demo vocabulary for real-time realistic signing (prepared, repaint not run)

**Who:** Nikos (with Claude)
**Question:** can we get ~25 more signs ready for the per-sign repaint (the real-time method in [2026-11-15-sentences-and-benchmarks.md](2026-11-15-sentences-and-benchmarks.md#update-real-time-built-same-day)), checked before spending money?
**Why it matters:** the 9 existing realistic clips only cover the three race sentences. A demo needs everyday conversation plus a medical/help scenario. This log covers everything **up to** the paid H3 Max Recast step. The owner approves the spend and runs `RUN-PAID.sh`.

## Setup
- **Library:** WLASL (`<signs>/index.json`, C-UDA non-commercial). Videos and motion JSON stay outside git.
- **Extraction:** `motion/batch_library.py` (MediaPipe holistic, `--trim-rest` cleanup), 5 workers, filtered index `index.vocab.json` (45 candidates). That's 108 s wall time for 45 signs, about 8–10 s each per worker.
- **Batching:** new `pipeline/make-batches.mjs`. It takes a gloss list, builds `NEUTRAL S1 NEUTRAL S2 ... NEUTRAL` with the same `concatClips` as `puppet/compose.mjs`, splits the list into the fewest balanced batches ≤ `--max-seconds` (12 here), and writes `vocab-N.clean.json` plus `vocab-N.json` (compose-style, with `segments`). It fails if any pause has fewer than 3 pure neutral frames.
  - **Regression check:** run on `hello my name "thank you" see`, it reproduces `batch-a.json` exactly: same segments, and frames byte-identical.
- **Render:** `puppet/render.mjs --view vrm`, run one batch at a time, 0.22–0.36 s per frame (52–91 s per batch).
- **Outputs (outside git):** `out/realtime/vocab/` holds the batch motion files, the `*.json` segments, `*-vrm.mp4` and `RUN-PAID.sh`. Motion is in `vocab/motion/`.

```bash
# from the repo root
node --experimental-strip-types --no-warnings pipeline/make-batches.mjs \
  --motion-dir out/realtime/vocab/motion --neutral out/realtime/neutral.clean.json \
  --out-dir out/realtime/vocab --prefix vocab --max-seconds 12 \
  i your please yes no good meet friend deaf understand again slow how want need now tomorrow \
  help sick pain head medicine water drink feel
```

## Chosen signs (25)
- **Conversation (17):** I, YOUR, PLEASE, YES, NO, GOOD, MEET, FRIEND, DEAF, UNDERSTAND, AGAIN, SLOW, HOW, WANT, NEED, NOW, TOMORROW. Greetings and politeness, yes/no answers, "I'm deaf, please sign slowly / again", questions, wants and time.
- **Medical / help (8):** HELP, SICK, PAIN, HEAD, MEDICINE, WATER, DRINK, FEEL. This covers "I feel sick", "head pain", "I need medicine", "please help", "I want water".
- **Race sentences:** sentences 2 and 3 are already covered by the existing 9 clips. Sentence 1 still needs fingerspelling `M-A-R-I-A`. WLASL has letter glosses (`a`, `i`, `m`, `r`), but signs separated by neutral pauses would drop the arm between letters. Fingerspelling needs its own clip (letters blended directly, no neutral), or a recorded alphabet. Not in this batch.
- **Example sentences with old + new clips:** `I DEAF, PLEASE SLOW AGAIN`, `NICE`→`GOOD MEET YOU`, `I FEEL SICK, HEAD PAIN`, `I NEED MEDICINE, PLEASE HELP`, `YOU WANT WATER?`, `SEE YOU TOMORROW`, `HOW YOU?`.

## Extraction quality (summary.csv, dominant hand detected in the trimmed span)
| Result | Signs |
|---|---|
| **Kept, ≥ 80%** | PLEASE 100, HELP 100, FEEL 100, NOW 97.1, DRINK 95.9, NEED 95.3, YES 95.1, AGAIN 95.0, TOMORROW 94.7, I 92.7, GOOD 92.6, HEAD 92.3, SICK 91.9, FRIEND 91.7, MEET 91.5, PAIN 91.5, NO 90.2, SLOW 90.0, WATER 88.6, YOUR 87.2, HOW 86.7, MEDICINE 86.0, UNDERSTAND 81.8, DEAF 81.6, WANT 80.6 |
| **Flagged < 80%, dropped** | SORRY 31.6, WHAT 68.4 (left-handed signer, mirrored, 19 frames), WHY 71.8, NICE 72.0, DOCTOR 72.1, TIRED 73.5, HOSPITAL 74.1 |
| **Dropped, other reason** | EMERGENCY (the source file is "Easter, Emergency": two signs in one clip), ME (same meaning as I; one is enough) |
| **Spare, passed QC, not batched** | FINE 94.3, BAD 96.4, WHO 97.1, WHEN 93.2, BATHROOM 91.7, TODAY 91.9, HOME 91.7, GO 84.8, EAT 93.1, LEARN 88.6, SIGN 83.7 |

DOCTOR and NICE would help the medical demo and the greeting. The index has only one video per gloss, so they need another WLASL instance or a re-record.

## Neutral pause: kept at 13 frames + 0.2 s blend (no change)
I measured instead of guessing (wrist steps in `poseWorld`, 15 signs, 24 fps):

| Neutral frames | Blend | Overlap per side | Pure neutral frames | Still run at the cut (<1 cm/frame) | Total frames (15 signs) | Peak wrist step at a join |
|---|---|---|---|---|---|---|
| **13 (current)** | 0.2 s | 5 | **3** | 3.8 frames (0.16 s) | 692 | 12.4 cm |
| 12 | 0.2 s | 5 | 2 | 2.8 | 676 | 12.4 cm |
| 11 | 0.2 s | 5 | 1 (unsafe) | – | 660 | 12.4 cm |
| 11 | 0.167 s | 4 | 3 | 2.9 | 690 | 12.7 cm |
| 9 | 0.2 s | 4 (clamped) | 1 (unsafe) | – | 658 | 12.7 cm |
| 9 | 0.125 s | 3 | 3 | 2.4 | 688 | **15.4 cm** |

- **The pure (unblended) neutral is only N − 2 × overlap frames.** With the 0.2 s blend (5 frames per side), 13 frames is the minimum that keeps 3 still frames, so 8–9 frames is not safe with the current blend.
- **Shortening the neutral and the blend together saves almost nothing.** The freed blend frames go back to the sign. Clips come out the same length (692 vs 688 frames over 15 signs), and the join gets about 24% faster/jerkier.
- **The true still pause is already short: about 0.16 s.** The perceived "stop" is mostly the signs' own slow near-rest heads and tails, left in by `--trim-rest`, plus the eased blend.
- **Decision:** keep the 13-frame neutral (hello raw frame 0) and the 0.2 s blend, so the new clips match the 9 existing ones exactly in pose and timing. To really shorten the pause, trim the sign rest tails tighter (next steps).

## Batches (rendered, ready for repaint)
| Batch | Signs | Frames (motion = mp4) | Seconds | Reserve (harness) |
|---|---|---|---|---|
| vocab-1 | I YOUR PLEASE YES NO | 242 = 242 | 10.08 | $5.05 |
| vocab-2 | GOOD MEET FRIEND DEAF UNDERSTAND | 224 = 224 | 9.33 | $4.67 |
| vocab-3 | AGAIN SLOW HOW WANT NEED | 218 = 218 | 9.08 | $4.55 |
| vocab-4 | NOW TOMORROW HELP SICK PAIN | 237 = 237 | 9.88 | $4.94 |
| vocab-5 | HEAD MEDICINE WATER DRINK FEEL | 243 = 243 | 10.13 | $5.07 |
| **Total** | **25 signs** | **1164** | **48.5** | **$24.28** |

- **Reserve** = $0.50 × max(frames/24, 5), rounded up to the cent. The free harness dry run (`e0.mjs --dry-run`, no upload) returned exactly these five numbers.
- **Size:** every batch is between 5 and 14 s, a single shot, with at least 3 pure neutral frames at every cut.
- **Expected fal time:** about 15 s per second of video, measured at 10.8–15.6 s/s on batch A, batch B and the sentence runs. That's about 2.5 min per batch, **~12 min total**, run one after another.
- **Per sign:** about $0.97 reserve. The listed Recast price ($0.085/s) is about $4.12 for all 48.5 s.

## Render checks (frames looked at, 2 per sign + the cut-point neutral)
- **Every neutral cut frame:** arms down, hands loosely together, identical across batches.
- **Clear handshapes:** I (pinky up), YOUR (flat palm out), YES (S-hand), NO (index+middle to thumb), MEET (two index fingers meet), FRIEND (hooked indexes), AGAIN, SLOW, HOW, WANT (claw hands pull in), NEED (X-hand), HELP (thumb-up on palm), PAIN (index fingers twist toward each other), SICK (one hand at forehead, one at stomach), UNDERSTAND (S then index flick by the head).
- **Weaker, but kept:**
  - **PLEASE:** the hand sits a little off the chest for part of the sign.
  - **DEAF:** the index rises only to chin level, short of the ear-to-mouth path.
  - **TOMORROW:** small.

  These are the known puppet hand-location limits, not tracking failures. A signer should check them after the repaint.
- **No fist-for-point failures** like the earlier YOU.
- **Batch 5:**
  - HEAD: bent hand at the temple, then lower.
  - MEDICINE: middle finger in the palm.
  - WATER: a W-ish hand tapping just below the chin. The fingers are partly merged.
  - DRINK: a C-hand rising to the mouth.
  - FEEL: open hand brushing up the chest.

  Nothing is broken enough to drop. WATER's handshape is the one to watch after the repaint.
- **Dry run of the cut + join, free, using the puppet mp4s in place of `generated.mp4`:**
  - `sign-clips.mjs cut` produced all 25 clips (29–63 frames each).
  - `say I FEEL SICK HELP PLEASE` joined them in 138 ms.
  - No clip id collides with the existing 9 in the manifest.

## The paid step (NOT run)
`out/realtime/vocab/RUN-PAID.sh`, run from the main checkout with `FAL_KEY` from the operator's environment. Per batch it:
1. Repaints only if `generated.mp4` doesn't exist yet.
2. Checks that the generated frame count equals the motion's, and stops if not, because the cuts must be frame-exact.
3. Cuts into `out/realtime/clips`, appending to the same `manifest.json`.

It ends with a `say` smoke test.

```bash
node pipeline/e0.mjs --puppet out/realtime/vocab/vocab-1-vrm.mp4 --source out/realtime/vocab/vocab-1-vrm.mp4 --model recast --resolution 768P --run-dir experiments/e0/runs/vocab-1 --execute --authorize-paid E0-PAID --max-usd 6
node pipeline/sign-clips.mjs cut --video experiments/e0/runs/vocab-1/generated.mp4 --segments out/realtime/vocab/vocab-1.json --out-dir out/realtime/clips
# same for vocab-2..5 with --max-usd 5, 5, 5, 6 (each >= its reserve)
```

## What I learned
- A real-time vocabulary costs about **$1 reserve and about 30 s of fal time per sign**. With extraction, batching and rendering, getting 25 signs ready took about 15 minutes, all on CPU.
- **The neutral pause is not what makes the gaps feel long; the sign tails are.**
- About 15% of WLASL signs fail the 80% hand-detection bar. Check `summary.csv` before batching. DOCTOR, NICE and SORRY are common words that need another source video.

## What I'd try next
- Trim sign rest tails tighter (velocity-based), then rebuild the batches. That's the real lever for shorter pauses.
- A fingerspelling unit for `M-A-R-I-A`: letters blended directly, bracketed by one neutral.
- Other WLASL instances (or a re-record) for DOCTOR, NICE, SORRY, WHAT, WHY.
