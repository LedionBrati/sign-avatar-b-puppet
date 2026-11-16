# 2026-11-16: finger fidelity metric, Recast baseline, and a race over every fal model

**Who:** Nikos (with Claude)
**Question:** which model turns our reference render into the realistic woman without losing fingers, and how do we measure "losing fingers" without a person looking at every frame?
**Why it matters:** a pointing puppet hand that comes out as a fist is a different sign. We need a number to beat before we spend on a new model or a new reference.

## Setup
- **Metric:** `motion/finger_fidelity.py`, run through `pipeline/finger-fidelity.mjs`. Free: MediaPipe on the CPU, no fal calls.
- **Data:** every existing Recast run with a puppet and a `generated.mp4` (63 pairs): `out/realtime/runs/*` (phrases, demo6, judges, lucky), `experiments/e0/runs/*` (batches, vocab, sentence) and `out/archive/e0-runs-sbp-mass/mass/*`. All frame-exact (Recast gives back as many frames as it gets).
- **Race harness:** `pipeline/race.mjs` with candidates in `pipeline/race/models.mjs`. A reference comes from `pipeline/race-prep.mjs`, and the pose video from `motion/render_pose.py`.
- **Research:** fal model pages and OpenAPI schemas, read on 16 Nov 2026. No paid calls.

## How the metric works
- Both videos go through MediaPipe Holistic, the same tracker the motion files come from. Hands are matched by the signer's side (left with left), and frames are matched by time.
- **Joint angle error:** per hand and frame we compute 15 finger flexion angles (3 per finger) from the 3D hand world landmarks, so image size and distance cancel out. We report the mean, median and p90 absolute difference, in degrees, over frames where both videos see the hand.
- **Handshape changed:** every finger gets a state: E (extended), B (bent) or C (curled), from its summed flexion. A frame counts as changed if any finger is E in one video and C in the other. A pointing index that becomes a fist counts; a slightly bent finger does not.
- **Hand lost:** the reference shows the hand and the output does not.
- **Scope:** only frames inside sign segments (from the batch's `<name>.json`), so neutral pauses don't dilute the score.
- **Three comparisons:**
  - reference video → output: what the repaint loses.
  - source motion → reference video: what the puppet loses.
  - source motion → output: everything, end to end.

  The source motion is the WLASL signer's hand landmarks the puppet was driven with, so it is the ground truth for the handshape.
- **Worst frames:** saved as a strip of images (top: reference crop with its skeleton in green, bottom: output crop in red), labelled with the frame, the sign, the E/B/C code of each video and the error.
- **Recognizer** (when `app/recognizer` answers on :8788): top-1 on each sign segment for the motion, the reference and the output.
- **Offset search** (`--max-shift`) for models that add a lead-in (DreamActor). It is off for frame-exact models.
- **Tests:** `motion/tests/test_finger_fidelity.py` (4 tests: angles, flips, drops, offset).

## Result

### 1. Baseline: today's pipeline (H3 Max Recast 768P on the anime puppet)

The full run took 49 min on the laptop CPU (124 videos, 10 processes). Landmarks are cached afterwards, so a re-score takes seconds.

```bash
MOTION_PYTHON=motion/.venv/Scripts/python.exe node pipeline/finger-fidelity.mjs --baseline --workers 10 --out out/finger/baseline \
  --roots out/realtime/runs,experiments/e0/runs,out/archive/e0-runs-sbp-mass/mass
```

63 pairs, sign frames only. Pooled over hand-frames:

| Comparison | Hand-frames | Joint err (deg) | p90 (deg) | Handshape changed | Index flipped | Hand lost |
|---|---|---|---|---|---|---|
| puppet video → Recast output (what the repaint loses) | 7,520 | **12.6** | 21.7 | **6.9%** | 2.6% | **2.8%** |
| source motion → puppet video (what the puppet loses) | 7,609 | 13.2 | 22.4 | 6.9% | 2.6% | 60.6% (MediaPipe can't find anime hands) |
| source motion → Recast output (end to end) | 18,127 | **13.8** | 26.1 | **7.8%** | 1.9% | **6.1%** |

| Group | Pairs | Repaint: joint err / shape changed | End to end: joint err / shape changed |
|---|---|---|---|
| realtime (phrases, demo6, judges, lucky) | 12 | 12.1° / 5.3% | 13.2° / 7.0% |
| e0 (batches, vocab, sentence) | 8 | 13.8° / 5.7% | 13.6° / 7.6% |
| mass | 43 | 12.6° / 7.5% | 13.9° / 8.0% |

**Recognizer**, top-1 on 340 sign segments:

| Input | Top-1 | Top-5 |
|---|---|---|
| Source motion | 95.3% | 96.8% |
| Puppet video | 30.0% | 47.6% |
| Recast output | **58.8%** | **79.1%** |

- The 95% on the source motion is a self-match: the templates were built from the same WLASL motion, so treat it as a ceiling, not an accuracy figure.
- The puppet video scores low because MediaPipe misses the anime hands.

**The numbers to beat:**
- **7.8%** of hand-frames change handshape against the source hands, at **13.8°** mean joint error.
- **6.1%** of hands are lost.
- **58.8%** recognizer top-1.

**Worst runs:**
- By handshape changed end to end: lucky-1 (24%), vocab-5 (19%), mass-004-5 (18%).
- Worst signs (repaint): WAY 58%, SINGLE 56%, SHOW 45%, QUESTION 44%, BELIEVE 43%.

Strips: [`assets/demo/finger/phr-1-recast-worst.jpg`](../assets/demo/finger/phr-1-recast-worst.jpg). Top row is the puppet, bottom row is Recast. Frame 48 is a bent "claw" that comes out as a flat open hand, and three frames lose the hand completely.

### 2. The metric agrees with our eyes on the 15 Nov model race

This re-scores the paid outputs we already had, at no cost:

```bash
node pipeline/race.mjs --ref out/puppet/judy-vrm.mp4 --motion out/motion/judy.clean.json \
  --existing recast=experiments/e0/runs/recast/generated.mp4,kling3std=out/bench/kling3.mp4,kling26std=out/bench/kling26.mp4,dreamactor=out/bench/dreamactor.mp4,wanturbo=out/bench/wanturbo.mp4
```

| Model | Handshape changed vs source hands | Joint err vs source (deg) | vs puppet video: changed / err | Hand lost | Index flipped |
|---|---|---|---|---|---|
| **H3 Max Recast** | **10.6%** | 12.4 | 12.4% / 13.3° | 3.6% | 3.8% |
| DreamActor v2 (offset found: +24 frames = its 1 s lead-in) | 18.7% | 12.0 | 12.2% / 12.9° | 1.5% | 3.7% |
| Kling v3 Std | 30.7% | 18.1 | 27.5% / 20.5° | 5.1% | 17.7% |
| Kling v2.6 Std | 32.6% | 17.6 | 31.7% / 20.4° | 6.1% | 18.8% |
| Wan 2.2 Animate Turbo | 41.8% | 21.1 | 43.3% / 22.1° | 21.9% | 12.2% |

- This matches the hand check in [`2026-11-15-fal-model-race.md`](2026-11-15-fal-model-race.md): Recast keeps fingers, Kling makes fists, Wan makes a fist pointed at the camera.
- Kling's worst frames: [`assets/demo/finger/judy-kling3-worst.jpg`](../assets/demo/finger/judy-kling3-worst.jpg). Pointing and open hands become fists (EBEEE → ECCCC, 48°). Recast's: [`judy-recast-worst.jpg`](../assets/demo/finger/judy-recast-worst.jpg).
- Kling outputs are 0.2 s shorter than the input, so their last few frames count as lost hands.

### 3. What exists on fal today (16 Nov 2026), ranked for "puppet/3D render → our woman, fingers kept"

Prices are from the fal model pages. Ones I re-checked myself are marked ✓. "(?)" means the page or schema returned 404 and the price comes from search snippets. fal publishes no latency for any of these; our measured times are in the 15 Nov race.

| # | Model | Endpoint | Takes | Price | Max | Hands |
|---|---|---|---|---|---|---|
| 1 | H3 Max Recast | `minimax/h3-max/recast` | RGB + 1-4 photos | ✓ $0.085/s 768P, $0.17/s 1080P, 5 s min, + $0.022/1k input tokens after 4,096 (~6,750 tokens/s): 10 s ≈ $2.24 | 30 s, shots ≤15 s | Best measured (above). Follows the puppet, mistakes included. |
| 2 | Wan 2.2 VACE Fun A14B pose / depth | `fal-ai/wan-22-vace-fun-a14b/pose`, `/depth` | **our own pose or depth video** (`preprocess: false`) + `ref_image_urls` | ✓ $0.10/s 720p, $0.075 580p, $0.05 480p; seconds = frames/16 | 241 frames | Only fal option that takes our exact hand keypoints. Identity weaker. **Removed 4 Jan 2027.** |
| 3 | H3 Max 3D-to-Video | `minimax/h3-max/3d-to-video` | 3D render + up to 8 photos | ✓ $0.50/request + $0.05/0.08/0.16 per s (480/768/1080p), 5 s min per shot, + $0.02/1k tokens after 4,096 | 15 s, 32 shots | Made for 3D renders; same family as Recast. Untested. |
| 4 | LTX 2.3 Render-to-Real | `fal-ai/ltx-2.3-quality/render-to-real` | CG render + first-frame image | ✓ $0.0024075 per megapixel (W×H×frames); 5.5 s at 720×960 = $0.23 | 481 frames | Restyles the render, so finger geometry should carry. Identity from the first frame only. Cheapest. |
| 5 | Kling v3 Pro Motion Control | `fal-ai/kling-video/v3/pro/motion-control` | RGB + 1 photo | ✓ $0.168/s (v3 Std ✓ $0.126/s, v2.6 Pro $0.112, v2.6 Std $0.07) | 30 s | Std versions made fists here. Pro not tried. The paper claims separate hand modelling. |
| 6 | DreamActor v2 | `fal-ai/bytedance/dreamactor/v2` | RGB + 1 photo (≤1920 px) | ✓ $0.05/s | 30 s | Second best measured. Adds a ~1 s lead-in, which the metric now finds. |
| 7 | SCAIL-2 | `fal-ai/scail-2` | RGB + photo, 3D-aware | $0.20/s (?) | ~6.7 s per call | No hand data. Schema not verified, so it's blocked in the harness. |
| 8 | LTX 2.3 reference v2v (IC control) | `fal-ai/ltx-2.3-quality/reference-video-to-video` | RGB + **our control video** (`skip_control_preprocess`) + image | per megapixel, as row 4 | 481 frames | No data. Schema not verified, so it's blocked. |
| 9 | Wan VACE 14B pose/depth, One-to-All 14B, Wan 2.2 Animate move/replace | `fal-ai/wan-vace-14b/*`, `fal-ai/one-to-all-animation/14b`, `fal-ai/wan/v2.2-14b/animate/*` | pose/depth; RGB; RGB | $0.04-0.12/s | | Wan Animate made a fist here. Animate and VACE 14B are deprecated too. |
| - | Kling O3 ref v2v, Kling 4.0 edit, Marey pose transfer, Decart Lucy restyle / 2.6 realtime | various | prompt-driven or live | $0.01-2/run | | Prompt swaps don't pin handshapes. Lucy realtime was tried 15 Nov: handshapes unreliable. |

**Not on fal:** Runway Act-Two / Aleph, Luma Modify, Pika motion transfer, UniAnimate, MimicMotion, StableAnimator, SteadyDancer.

**Self-host on a rented GPU** (numbers from the model repos and GPU guides, not measured by us):

| Model | VRAM | Speed | Why |
|---|---|---|---|
| Wan2.2-Fun-A14B-Control / VACE | ~65-80 GB at 720p; fp8 + block swap fits a 24 GB 4090, slowly | Wan-14B 720p 5 s ≈ 5 min on H100 | Takes our DWPose-with-hands, depth or normal render directly. Same model as row 2, without the Jan 2027 deadline. |
| UniAnimate-DiT (Wan 14B) | 14-23 GB 480p, 26-36 GB 720p | ~3 min per 5 s at 480p with TeaCache | DWPose-driven; feed it our skeleton. |
| SteadyDancer-14B | 43 GB | 17 min per 81 frames on H800 | DWPose; better FVD than Wan-Animate. |
| SCAIL-2 (MIT) | fp8 | ~85 s per 81 frames, fast preset | 3D-aware, end to end. |
| Wan2.2-Animate-14B | ~48-60 GB | ~1 s of video per minute on H100 | Weak hands by default. |

MimicMotion and StableAnimator are older SVD-based models, not worth it. HandRefiner is image-only; a video hand-fix pass would be VACE inpainting over a hand mask, driven by our depth plus hand keypoints.

### 4. The race harness, and the proposed race on HELLO, WATER, THANK YOU

```bash
# 1. reference: cut from batches we already rendered, NEUTRAL HELLO NEUTRAL WATER NEUTRAL THANK_YOU NEUTRAL
node pipeline/race-prep.mjs --signs HELLO,WATER,THANK_YOU --name demo3 --out out/race/demo3
#    -> demo3-vrm.mp4 (133 frames, 5.54 s), demo3.json (segments), demo3.clean.json (motion), demo3-pose.mp4 (skeleton with hands)
#    Swap demo3-vrm.mp4 for the realistic 3D avatar render of the same motion when it exists, and add its depth render.

# 2. dry run (default): exact plan and cost, nothing uploaded
node pipeline/race.mjs --ref out/race/demo3/demo3-vrm.mp4 --pose out/race/demo3/demo3-pose.mp4 \
  --depth out/race/demo3/demo3-depth.mp4 \
  --models recast,recast1080,h3_3d,kling3pro,dreamactor,ltx_r2r,vace_pose,vace_depth --run-dir out/race/runs/demo3

# 3. paid, only with the team's go-ahead (not run):
FAL_KEY=... node pipeline/race.mjs <same flags> --execute --authorize-paid RACE-PAID --max-usd 8
```

Paid mode:
- refuses unverified schemas and any plan over `--max-usd`
- pads clips to each model's minimum
- submits all jobs at once and logs request IDs as they're issued
- downloads every output, scores each one with the finger metric (with the offset search for DreamActor) and ranks them

Cost of the proposed race: one call per model, all 3 signs in one 5.54 s clip, like a real batch.

| Model | Cost | Price basis |
|---|---|---|
| recast (control) | $1.204 | exact |
| recast1080 | $1.676 | exact |
| h3_3d | $1.610 | reserve: token rate assumed equal to Recast's |
| kling3pro | $0.932 | exact |
| dreamactor | $0.328 | reserve: +1 s lead-in billed |
| ltx_r2r | $0.229 | exact |
| vace_pose | $0.832 | reserve: frames/16 |
| vace_depth | $0.832 | reserve: needs the depth render |
| **Total** | **$7.64** | |

Without a depth render it's $6.81. SCAIL-2 (+$1.11) and LTX IC-pose (+$0.23) wait for a schema check.

The pose video only conditions pose-driven models. It is re-framed to the avatar's proportions: shoulders where MediaPipe finds them in the Recast outputs.

## What I learned
- **The metric works and agrees with what we saw by eye.** It ranks the 15 Nov race the way the manual frame check did, and it finds DreamActor's 1 s lead-in by itself. That makes a race fully automatic: run, score, read the strip of worst frames.
- **Recast is not the main finger loss.** On 63 runs it keeps the puppet's handshape in 93% of hand-frames. End to end against the source hands it's 92%, with 6% of hands lost.
- **The puppet is the other half of the problem.**
  - Motion → puppet video already changes 6.9% of handshapes.
  - MediaPipe finds only 39% of the puppet's hands. The anime hands are hard to read, for a tracker and probably for the repaint models too.
  - A realistic 3D reference should help every RGB-driven model. This is the best argument for the realistic 3D avatar.
- **The output is more readable than the puppet:**
  - Recognizer top-1: 58.8% on the Recast output against 30% on the puppet video. Recast "cleans up" hands into something a tracker reads.
  - It's still far from the source (the source's 95% is a self-match ceiling).
- **Weakest signs:** the curled and bent ones (claw, bent-V, flat-O: WAY, SINGLE, SHOW, QUESTION, BELIEVE). Recast tends to open them into flat or extended hands.
- **Pose-driven models are the one route where fingers can't be guessed from pixels.** On fal that is Wan VACE pose/depth, which goes away on 4 Jan 2027. Self-hosted, it's Wan-Fun-Control or UniAnimate-DiT with our skeleton.

## What I'd try next
1. **Run the proposed race ($7.64) on the realistic 3D render as soon as it exists.** Use the same motion (demo3), plus its depth video. The harness does the scoring. Keep Recast as the control.
2. If VACE pose or depth beats Recast on handshape and the identity holds, plan a self-hosted Wan-Fun-Control or UniAnimate-DiT on a rented H100 before fal drops VACE.
3. Re-run the baseline after the clean hand motion lands: `node pipeline/finger-fidelity.mjs --baseline` (cached, seconds). The motion → puppet column shows the gain on its own.
4. Make the recognizer score fairer: accept synonyms (`bye` for GOODBYE), and add templates from a second signer so the source motion is no longer a self-match.
5. Thresholds (E ≤ 75°, C ≥ 150° summed flexion; thumb 45°/95°) were set by eye on a few strips. Check them against a fluent signer's labels on 50 frames.
