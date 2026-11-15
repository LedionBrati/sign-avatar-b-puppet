# 2026-11-15: whole sentences from separate signs, and how long each step takes

**Who:** Nikos (with Claude)
**Question:** can the puppet join several separate signs into one sentence, and how long does each step from text to realistic video take?
**Why it matters:** the product signs sentences nobody filmed. One clip in, one clip out (E0, PR #17) isn't enough.

## Setup
- **Signs:** 9 WLASL isolated signs (`hello my name thank_you see you later where hurt`), extracted with `motion/batch_library.py`. Cleaned with `--trim-rest`. MY came from a left-handed signer and was auto-mirrored.
- **Composer:** new `puppet/compose.mjs`. It wraps the existing `puppet/src/blend.ts`: 0.2 s eased cross-blend, output at 24 fps, and optional `--min-seconds` padding (a held last pose) for Recast's 5 s minimum.
- **Three sentences:**

  | Sentence | Signs | Length | Frames |
  |---|---|---|---|
  | `HELLO MY NAME` | 3 | 3.96 s | 96 |
  | `THANK YOU SEE YOU LATER` | 4 | 5.25 s | 127 |
  | `YOU HURT WHERE` | 3 | 4.38 s | 106 |

- **Puppet render:** `puppet/render.mjs --view vrm` (headless Chrome, software WebGL), on an i7-1355U laptop with no GPU.
- **Repaint:** H3 Max Recast on `THANK YOU SEE YOU LATER`, 768P, through the gated harness. Request `01a1dc8d-5460-7600-bff8-d838e687bbf2`.

  ```bash
  node --experimental-strip-types puppet/compose.mjs --out out/sentences/thank-you-see-you-later.clean.json \
    thank_you.clean.json see.clean.json you.clean.json later.clean.json
  node puppet/render.mjs --motion out/sentences/thank-you-see-you-later.clean.json --view vrm --out ...-vrm.mp4
  node pipeline/e0.mjs --puppet ...-vrm.mp4 --source ...-ref.mp4 --model recast --execute --authorize-paid E0-PAID --max-usd 5
  ```

## Result
- **Videos:**
  - [`assets/demo/sentences/thank-you-see-you-later-comparison.mp4`](../assets/demo/sentences/thank-you-see-you-later-comparison.mp4): the 4 real signer clips joined | puppet | realistic avatar.
  - [`assets/demo/sentences/thank-you-see-you-later-avatar.mp4`](../assets/demo/sentences/thank-you-see-you-later-avatar.mp4): the avatar alone.
- **Joining works:** one continuous motion, no cuts. Recast keeps it frame-exact: 127 frames in, 127 out.
- **Handshapes carry through:** THANK YOU flat hand, SEE V-shape, LATER index up.
- **YOU comes out as a fist instead of a pointing index.** Check the WLASL tracking for that clip.

### Benchmarks

| Step | When it runs | Time | Notes |
|---|---|---|---|
| Extract one sign (MediaPipe) | **once per sign, offline** | 6–26 s per sign (median 12 s) | 9 signs, 5 workers, CPU only |
| English → gloss (Claude) | per sentence | not measured yet (no key on this machine) | expected about 1–3 s |
| Join the signs | per sentence | **0.10–0.19 s** | mostly reading the 1–3 MB JSON files |
| Puppet, live in the browser | per sentence | **real time** | the viewer already plays it live |
| Puppet, rendered to mp4 offline | per sentence (repaint only) | 54–77 s per sentence (0.57–0.66 s per frame) | headless screenshots, software WebGL |
| H3 Max Recast | per sentence | **82–90 s** for 5.3–5.9 s of video (about 15× slower than real time) | reserve ≤ $2.65–2.96 per call; 5 s minimum |
| **Text → live puppet** | | **about 1–3 s** | gloss + join |
| **Text → realistic avatar** | | **about 2.5 min** | render + Recast |

## What I learned
- The puppet can already sign any sentence our dictionary covers. Joining takes a fraction of a second.
- **Arms dip toward the waist between signs** (frames 48 and 74 of the sentence). The trimmed clips still start and end near rest. Fix: trim tighter, or blend from the end of one sign's motion straight into the start of the next (co-articulation).
- **The bottleneck is the repaint:** about 85 s per sentence. The offline puppet render (about 65 s) is the second, but that one is easy to fix (see below).

## How to get to real time
1. **The live puppet is real time today:** text → gloss → join → play in the browser takes about 1–3 s. It's the cartoon look.
2. **Realistic and instant: pre-render each sign once, not each sentence.**
   - Render every dictionary sign through the puppet starting and ending in one **fixed neutral pose**, and Recast it once.
   - At runtime, play the realistic clips back to back. They all begin and end in the same pose with the same avatar, so they join without jumps.
   - Cost: batch 3–4 signs per Recast call (5 s minimum). About 2 s per sign × $0.085/s listed price, so roughly $0.20 per sign: about $4 for a 20-sign demo vocabulary, about $350 for all 1,945.
   - **Trade-off:** you lose the smooth blends between signs, which go back to cuts at the neutral pose.
3. **Faster offline render:** record the WebGL canvas in real time (WebCodecs or MediaRecorder) instead of a screenshot per frame. That takes about 60 s down to about 5 s, but it only matters while repaint stays per sentence.
4. **Live repaint (experimental, README 6.8):** a realtime video-to-video model such as `decart/lucy-2-6/realtime` over WebRTC, restyling the live puppet stream. Finger accuracy is unknown, so it needs its own test.
5. **Smaller wins:** stream the gloss call (low effort), use binary motion files instead of 3 MB JSON, stream speech-to-text.
