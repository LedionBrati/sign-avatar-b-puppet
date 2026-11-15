# 2026-11-15: fal model race, which repaint model is fastest (and keeps the hands)?

**Who:** Nikos (with Claude)
**Question:** is any fal motion-transfer model faster than H3 Max Recast on our puppet? And does splitting a sentence across parallel calls help?
**Why it matters:** the owner wants on-the-fly generation as close to real time as possible.

## Setup
- **Input:** `judy-vrm.mp4`, the PR #15 puppet: 5.92 s, 142 frames, 540×720. Avatar: `assets/avatar/avatar-main.jpg`; DreamActor got a 1080 px-tall copy because of its size limit.
- **Script:** `pipeline/bench-models.mjs` submits every job at once. It times the **queue wait** (submit → IN_PROGRESS) separately from **processing** (IN_PROGRESS → COMPLETED), and logs each request ID as soon as it's submitted.
- **Models:**

  | Model | Endpoint and settings |
  |---|---|
  | Recast | `minimax/h3-max/recast` 768P (baseline from PR #17) |
  | Kling v3 | `fal-ai/kling-video/v3/standard/motion-control` |
  | Kling v2.6 | `fal-ai/kling-video/v2.6/standard/motion-control` |
  | DreamActor | `fal-ai/bytedance/dreamactor/v2` (`trim_first_second: false`) |
  | Wan Turbo | `fal-ai/wan/v2.2-14b/animate/move` (480p, `use_turbo: true`) |

- **Parallel test:** `batch-a-vrm.mp4` (8.96 s) cut into two halves, each padded to Recast's 5 s minimum, and both repainted at the same time.

## Result

| Model | Processing | Queue | Output | Hands at frame 100 (index + pinky) |
|---|---|---|---|---|
| **H3 Max Recast** | **90 s** | about 0 s | 142 f, 24 fps, 768×1024, frame-exact | ✓ index + pinky + thumb |
| DreamActor v2 | 94 s | 3 s | 173 f @25 (about 1 s longer: it adds a lead-in) | can't compare (time-shifted) |
| Wan 2.2 Turbo | 101 s | 3 s | 143 f @24, 544×720 | ✗ fist pointed at camera |
| Kling v2.6 Std | 270 s | 5 s | 171 f @30, 816×1104 (same duration) | ✗ two fists |
| Kling v3 Std | 294 s | 4 s | 171 f @30, 816×1104 | ✗ two fists |

- **Same moment in all five:** [`assets/demo/bench/frame100-five-models.png`](../assets/demo/bench/frame100-five-models.png). Left to right: Recast, Kling v3, Kling v2.6, DreamActor, Wan.
- **Parallel split:** 9 s of video in **72 s wall time**, against 97 s as a single call (−26%). The halves took 64 s and 70 s.
- **Live option not raced:** `decart/lucy-2-6/realtime` (WebRTC, $0.02/s, "near-zero latency", character swap from a reference image) only runs over a live streaming connection, so it can't go through this file-based race. It's the only real-time candidate on fal and needs its own browser test.
- **Spend:** a first attempt crashed after submitting the 4 model jobs (my padding bug made the split jobs fail validation, and the error killed the script before the results were saved), so those 4 jobs ran and were billed but their outputs were lost. The re-run is what's reported here. Check the fal dashboard for real totals.

## What I learned
- **H3 Max is both the fastest and the most accurate.** The others are as slow or 3× slower, and turn handshapes into fists.
- **Parallel chunks help long sentences:** about 26% on 9 s. It grows with length, because each chunk costs about 65–70 s whatever its size above the 5 s minimum.
- **None of the file-based models is anywhere near real time** (about 15 s of processing per second of video). For real-time realistic output we have two choices:
  1. Pre-rendered clips per sign (built, about 170 ms per sentence).
  2. The live Lucy model (untested).
