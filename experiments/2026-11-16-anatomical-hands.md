# 2026-11-16: anatomical 3D hands for the motion dictionary (motion v2)

**Who:** Nikos (with Claude, agent A)
**Question:** Can we replace MediaPipe's raw finger points with hands that are always anatomically possible (fixed bones, joint limits, IK, smoothing), and which 3D hand model should feed them on a rented GPU?
**Why it matters:** the puppet copies MediaPipe's 21 points straight onto the VRM fingers. Those points bend fingers backwards and sideways, stretch bones by 8 to 27%, and a pointing hand can come out as a fist. Recast then paints whatever the puppet shows. Wrong fingers in, wrong fingers out.

> Nothing below says a sign is linguistically right. The numbers only say whether a hand is physically possible and how steady it is. Only a fluent signer can judge the signs.

## Which 3D hand model (checked 2026-11-16)

| Model | What it gives | Fast / occluded signing hands | Speed | Weights | Licence and signups |
|---|---|---|---|---|---|
| **WiLoR** (CVPR 2025) | MANO hand per crop, own YOLO detector | Best published hand accuracy (PA-MPJPE 5.5 mm FreiHAND), robust in the wild; what the 2026 sign-avatar paper Tamaththul3D uses for hands | Detector 138 fps on a 4090; the ViT-L regressor is the heavy part | Public on Hugging Face, no signup (2.56 GB) | CC BY-NC-ND 4.0. **Needs MANO** (refinement samples the MANO mesh). Detector uses ultralytics (AGPL-3.0), which we skip |
| HaMeR (CVPR 2024) | MANO hand per crop | Strong on occlusion (HInt data), slightly behind WiLoR | ViT-H, ~2x slower than WiLoR | Public (2.6 GB + ViTPose body detector) | Code MIT; needs MANO for joints |
| SMPLer-X / SMPLest-X (2025) | Whole body SMPL-X incl. hands | Hands clearly worse than hand-only models (hand MPE 31.6 mm); Tamaththul3D pairs SMPLer-X body with WiLoR hands | Heavy (ViT-H, 687 M params) | Public | SMPLest-X CC BY 4.0 code; **needs SMPL-X** (registration, non-commercial) |
| OSX | Whole body SMPL-X | Older than SMPLest-X | Heavy | Public | Needs SMPL-X |
| RTMW3D (MMPose / rtmlib) | 133 3D keypoints incl. 21 per hand | 2D good, 3D depth weak; points, not a hand model | Real time, runs on CPU (ONNX) | Public | Apache-2.0, no signup |
| MediaPipe Holistic (today) | 21 points per hand | Loses or garbles blurred hands (see below) | ~6 fps on this laptop | Public | Apache-2.0 |

**Chosen:** our own anatomical skeleton + IK on top of any keypoint source. Today the source is MediaPipe (CPU, no signup). On a rented GPU it is WiLoR (needs the owner's free MANO registration). Same limits, smoothing and output format either way. MANO-free alternatives were checked: none gives better hands than WiLoR, and `wilor-mini` on PyPI downloads a re-hosted `MANO_RIGHT.pkl` from a third party, which the MANO licence does not allow, so we don't use it. Body: left as v1 pose for now; SMPLest-X (needs SMPL-X) is the next step if the body needs it.

## Setup
- **Inputs:** WLASL motion files (`out/motion/wlasl/*.raw.json` + `.clean.json`) and source videos for the 20 demo signs; detail on HELLO (signer 46, 1280x720), NO (fast handshape change, index+middle snapping onto the thumb), WHERE (736x414, blurry, many lost frames) and YOU (pointing at the camera, the "pointing becomes a fist" case).
- **Skeleton** (`motion/hand_model.py`): MANO joint order, 17.9 cm adult hand, PIP/DIP hinges, knuckles flex + spread, thumb CMC flex + abduction + roll; 22 angles with ranges from hand-therapy ROM tables plus ~5-10 deg slack; oblique axes for ring and little finger (a fist converges toward the thumb base). Fit: projected Levenberg-Marquardt on unit bone directions, vectorised over frames, then a second pass pulled toward the neighbours' median angles.
- **Pipeline** (`motion/hands3d.py`): observation (WiLoR > Holistic raw > re-detection) -> IK -> fits more than 30 mm off are dropped -> gaps <= 6 frames filled in joint-angle space -> One Euro on angles (2.0 Hz / beta 5, picked from a sweep, below) and on the wrist quaternion -> `.v2.json`. Re-detection (`motion/redetect.py`): frames where Holistic lost the hand or returned an impossible one get a zoomed crop around the pose model's hand and MediaPipe HandLandmarker.
- **Commands** (from `motion/`):
  ```bash
  uv sync                                   # adds scipy
  uv run python batch_hands3d.py --index <signs>/index.json --motion-dir ../out/motion/wlasl \
      --out-dir ../out/hands3d/demo --only demo --workers 3
  uv run python hands_report.py --raw X.raw.json --clean X.clean.json --v2 ../out/hands3d/X.v2.json \
      --video <signs>/videos/X.mp4 --out-dir ../out/hands3d/X-report
  uv run pytest -q                          # 35 tests (11 new), all pass
  ```
- **GPU path smoke test on CPU:** `hands_gpu.py --mano stub --limit-frames 12` on HELLO with the real `wilor_final.ckpt`: WiLoR code + weights load with 0 missing keys (13 unused), 24 hand crops run end to end, **9.8 s per hand on this CPU** (load 160 s). With the stub MANO the joints are zeros by design, so no quality numbers for WiLoR yet.

## Result
- **Outputs:** `out/hands3d/demo/<stem>.v2.json` + `summary.csv` (git-ignored), reports with `grid-right.png` in `out/hands3d/<stem>-report/`. Three grids are committed: [`hello`](../assets/demo/hands3d/hello-grid.jpg), [`no`](../assets/demo/hands3d/no-grid.jpg), [`you`](../assets/demo/hands3d/you-grid.jpg) (video crop with MediaPipe in red | the same crop with the fitted hand in green | both hands from the thumb side).

### 20 demo signs, dominant hand, frames of the trimmed clip

| | MediaPipe raw | fitted v2 |
|---|---|---|
| Hand-frames with an impossible pose (finger hinge bent backwards > 35 deg or sideways > 30 deg, knuckle or thumb far out of range) | **median 22%** (2% MEET to 87% PLEASE; HUNGRY 86%, HURT 70%, YOU 50%) | **0% in all 20** |
| Bone length spread over time (CV) | 8 to 27% (4 detail clips) | 0.1% (rounding) |
| Finger angle jitter (mean 2nd difference of 12 flexion angles) | median 13.9 deg | median 7.5 deg (**-46%**) |
| Fastest angle changes kept (p95 angle speed, v2/raw) | | median 0.6 (0.1 to 1.05) |
| Hand present (raw Holistic vs v2) | median 89.3% | median 89.6%; up on WHERE 70.6 -> 85.3, WATER 71.4 -> 91.4, NEED 81.4 -> 95.3; down where frames were dropped as unfittable (HUNGRY 97.3 -> 67.6, PLEASE 100 -> 83.9) |
| Mean fit distance to the observation | | median 13.9 mm (mostly MediaPipe's short fingers vs. the anatomical skeleton) |
| CPU time | | **5.3 s per sign** with 3 workers (re-detection included), 1,945 signs about 2.9 h |

Detail clips (from each `summary.json`):

| clip | impossible raw -> v2 | angle jitter raw -> clean v1, then raw -> v2 on the frames v2 kept (deg) | motion kept v2 | sources (holistic / redetect / filled) |
|---|---|---|---|---|
| HELLO | 16.2% -> 0% | 19.7 -> 15.6; 14.0 -> 8.7 | 0.86 | 33 / 2 / 0, 2 dropped |
| NO | 8.1% -> 0% | 12.9 -> 9.3; 10.9 -> 7.3 | 0.81 | 36 / 1 / 0, 1 dropped |
| WHERE | 25.0% -> 0% | 11.9 -> 12.3; 11.9 -> 7.4 | 0.77 | 22 / 3 / 4, 2 dropped |
| YOU | 50.0% -> 0% | 28.2 -> 26.6; 13.3 -> 9.3 | 0.62 | 24 / 6 / 0, 4 dropped |

- The v1 cleanup (One Euro on points) does not fix any of this: it leaves impossible poses in (HELLO 16 -> 19%, YOU 50 -> 56%), because smoothing two wrong frames gives a wrong frame.
- **What the grids show.** HELLO f2: MediaPipe bends all four fingers backwards (8 impossible joints); the fit is a flat hand. NO f5/f11: MediaPipe draws index + middle as short stubs; the fit has them extended upward, as in the video. YOU f10-f11 (index pointing at the camera): in the side view MediaPipe curls all four fingers (a fist) while the fit keeps one finger out; in the image overlay the foreshortened finger is hard to judge, so this one needs a puppet render to confirm. Frames where the hand is half out of the picture (YOU f2-3, NO f39 in earlier runs) gave garbage that is now dropped (fit > 30 mm) or kept with low `conf`.
- **Smoothing sweep** (HELLO, NO, WHERE, THANK_YOU, angle One Euro min_cutoff/beta): 1.0/1.5 cut angle jitter most (to 2.8-9.4 deg) but kept only 50-67% of the fastest angle changes; 2.0/5.0 kept 62-86%; 4.0/12.0 kept 76-94% with little jitter gain over v1. Chose 2.0/5.0. "Kept" compares with raw MediaPipe, whose fastest changes are partly its own flips, so it under-states what survives; a synthetic 90 deg handshape step is followed to 90% within 2 frames (test).
- **Impossible-pose checker, honestly.** On 300 random valid hands it flags about 1% (extreme corners of the limits). The first version flagged curled ring/little fingers as "bent sideways" (81% on NO); real fists converge toward the thumb, so the skeleton now has oblique axes and the checker uses the finger's own bend plane when the knuckle is flexed past ~70 deg.
- **Scores, 1 to 5:** Correct signs: not judged (needs a signer). Smooth: 4 (angle jitter about halved). Looks real: n/a until rendered. Speed: 5.3 s per sign on CPU. Cost: $0.

### GPU on Modal: not run
Modal is set up (workspace "fourlhs"). Two things block a real WiLoR run, both need the owner:
1. **MANO_RIGHT.pkl**: register free at https://mano.is.tue.mpg.de (non-commercial licence), download "Models & Code", put `mano_v1_2/models/MANO_RIGHT.pkl` on the volume (`modal volume put signlayer-hands MANO_RIGHT.pkl /mano/MANO_RIGHT.pkl`).
2. **Uploading the WLASL videos (C-UDA, non-commercial) and motion files to a Modal volume** was refused by the session's permission check; the owner has to approve that upload (or run `modal_hands.py::upload` themselves).
Estimate once unblocked: WiLoR needs ~80 crops per sign; on an L4 the network is ~1 s per sign, the rest is video decode and crop preparation, so about 10 s per sign: **20 demo signs ~4 min (~$0.10), all 1,945 ~5.4 container-hours (~$4.30 at Modal's L4 rate, under $8 even at 2x), ~35 min wall with 10 containers.**

## What I learned
- **MediaPipe's fingers are physically impossible in about a fifth of signing frames, and in half or more for signs with curled or pointing fingers** (HUNGRY, PLEASE, HURT, YOU). That is the "pointing hand becomes a fist" bug, measured.
- **An anatomical skeleton fixes the impossible poses for free and halves finger jitter,** at the price of some of the fastest changes. It cannot invent information: in heavily blurred frames it gives a possible hand, not necessarily the right one. `conf` and `src` say which frames to trust.
- **MediaPipe's world hands have short fingers** (index proximal phalanx ~0.3 of the palm length vs ~0.5 in a real hand). Driving the puppet with MediaPipe's proportions makes every finger look stubby, which in a blurred render reads as a fist. The v2 file uses real proportions.
- **Re-detecting on a zoomed crop rarely finds a hand Holistic lost** (0 of 4 on HELLO: the hand was out of the picture; 3 of 10 on WHERE), but it often gives a possible hand where Holistic's was impossible.
- **numpy small-matrix code was 30x slower with a multi-threaded BLAS on the shared laptop;** `hand_model.py` pins BLAS to one thread.

## What I'd try next
- Owner: MANO signup + approve the upload, then `modal run motion/modal_hands.py --only demo` and compare WiLoR vs MediaPipe with `hands_report.py` (same numbers as above).
- Puppet: drive the VRM fingers from `hands3d.rot` (or the fitted `*HandWorld`, already in the v2 file) and re-render the 9 test phrases; check whether Recast keeps pointing hands pointing.
- Have a fluent signer look at the three grids and at puppet renders of HUNGRY, PLEASE and YOU.
- Per-signer hand proportions instead of one standard hand, and a learned pose prior instead of box limits.
