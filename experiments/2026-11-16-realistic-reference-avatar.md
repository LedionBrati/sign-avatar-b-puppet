# 2026-11-16: a realistic reference signer with anatomical hands

**Who:** Nikos (with Claude)
**Question:** if the 3D reference the video model repaints is a realistic person with clear, anatomically possible fingers, instead of the anime VRM, do the hands survive better? And can it render fast?
**Why it matters:** fingers come out wrong in the fal output (a pointing hand becomes a fist). The reference is part of the cause: white anime hands on a white T-shirt, cel shading, and finger angles copied straight from noisy MediaPipe points with no joint limits.

## Setup
- **Avatar:** `puppet/models/signer.glb`, built headless by `node puppet/avatar/build.mjs` with MPFB 2.0.18 (MakeHuman for Blender) in Blender 4.5. A woman with realistic proportions, MakeHuman "mixamo" rig (3 bones per finger and thumb, plus a tip bone per finger), CC0 skin, eyes, brows and long hair, and a black long-sleeve top painted onto the body by bone weights (cuff at the wrist, crew neck). Licence: CC0 (MakeHuman base mesh and system assets); MPFB itself is GPL-3.0, its output is not. Details: [`puppet/avatar/README.md`](../puppet/avatar/README.md).
- **Look:** soft light (room environment map, large key from camera-left, neutral tone mapping), grey wall `#33363a`, framed like `assets/avatar/avatar-main.jpg` (hair top at 20%, chin at 47%, waist at the bottom).
- **Hand solver** (`solver=anatomic`, [`puppet/src/hand.ts`](../puppet/src/hand.ts)), the default for the new avatar:
  - Palm frame from wrist, index, middle and pinky knuckles. If 3+ fingers would bend backwards past 70°, the tracker read the palm inside out (this happens edge-on); the palm normal is flipped instead.
  - 20 joint angles per hand: MCP spread + flexion, PIP, DIP; thumb CMC spread + flexion, MCP, IP.
  - Joint limits from range-of-motion tables (MCP -25..95°, PIP -5..110°, DIP -10..85°, thumb ranges), spread centred on the data's flat-hand neutral (9,783 WLASL hand-frames). One coupling: a bent knuckle can spread less (down to 25% at 90°), so a fist doesn't cross its fingers.
  - IK: damped least squares per finger toward the landmark joints (scaled to the avatar's finger length), projected onto the limits, plus a "don't go into the palm" term. When thumb tip and index or middle tip touch in the source, the thumb aims at the avatar's fingertip, so pinches survive the different proportions.
  - No self-intersection: neighbouring fingers are capsules (6.5 mm radius). Overlaps are pushed apart by small spread or curl moves, at most 12° per joint, so the handshape never changes into another one.
  - Zero-phase one-euro smoothing over the clip (forward, then backward), so nothing lags.
  - Motion v2 `hands3d` (agent A, `agent-a/hands3d`) is used when present, else `*HandWorld`, else the image points. Body and arms use the existing `direct` retargeting. `direct` and `kalidokit` still work.
- **Passes:** `render.mjs --passes rgb,depth,normal,seg` writes `x.mp4`, `x.depth.mp4` (white = near, 1.2 m slab around the body), `x.normal.mp4` (view-space) and `x.seg.mp4` (one flat colour per finger, palms per side). All come from the same camera and are frame-aligned.
- **Speed work in `render.mjs`:**
  - `--capture jpeg` (new default for `--view vrm`): the browser's own JPEG encoder, 24 frames per page call, mjpeg into ffmpeg. The old path drew a PNG, base64-encoded it per frame and decoded it in ffmpeg.
  - `--lite`: Lambert shading with a hemisphere light instead of PBR + environment map, for software WebGL.
  - `--aa 0` and `--workers N` (several Chrome processes).
- **Measurement:** `render.mjs` now reports joint-limit violations and overlapping fingers of the hand as shown, for any avatar, with the same angle reader. `puppet/scripts/hand-limits.ts` counts them on the input landmarks.
- **Machine:** the team laptop (i7-1355U, Intel Iris Xe, no NVIDIA). Other jobs were running during some timings, so the software numbers are noisy. The laptop overheated near the end, so the remaining heavy runs moved to `puppet/modal_render.py` (commands below, not run yet).

## Result

**Joint limits** (phr-3, `HEARING LEARN TEACHER STUDENT YESTERDAY HOT`, 248 frames, 295 tracked hand-frames):

| | old: anime VRM, `direct` | new: signer, `anatomic` |
|---|---|---|
| Finger joints outside the limits | **1,137** (in 266 of 295 hand-frames) | **0** |
| Overlapping neighbour fingers (finger-pairs × frames) | 154 | 1 |
| Mean finger direction vs landmarks | 6-7° | 21-23° (the price of the limits: the tracker's impossible angles are not copied) |

- HELLO (new): 0 violations in 37 hand-frames.
- demo3 (HELLO WATER THANK_YOU, new): 0 violations in 117 hand-frames, 0 overlaps.
- HELLO from agent A's v2 file (`hands3d`): 10-frame smoke render, 0 violations, 2 more hand-frames than v1 (v2 fills them).
- The input landmarks themselves break the limits a lot. 20 demo signs + phr-3: 1,242 hand-frames, 4,640 violations under a first, stricter version of the limits. The worst offenders are spread and PIP.

**Can a tracker read the hands?** I ran agent C's free finger metric (`motion/finger_fidelity.py pair`, branch `agent-c/finger-fidelity-race`) on the same motion, `out/race/demo3/demo3.clean.json`, rendered both ways (`ref` = anime `demo3-vrm.mp4`, `gen` = `demo3-signer.mp4`). It scores sign frames only.

| demo3, 117 hand-frames in the motion | anime VRM puppet | realistic signer |
|---|---|---|
| Hands MediaPipe finds in the render | **45 (38.5%)** | **102 (87.2%)** |
| Mean finger joint error vs the motion | 9.9° | 9.9° |
| Handshape changed vs the motion | 2.2% | 3.9% |

The handshape change is over 102 frames instead of 45, and includes the frames where the limits overrode the tracker on purpose.

**Speed** (phr-3, 248 frames, 540×720, one Chrome):

| Setting | s/frame | fps |
|---|---|---|
| Old: anime VRM, PNG capture, software WebGL | 0.829 (0.45 unloaded, earlier logs) | 1.2 |
| Signer, PNG capture, software | 0.665 | 1.5 |
| Signer, JPEG capture, software | 0.395 | 2.5 |
| + `--aa 0` | 0.330 | 3.0 |
| + `--workers 4` | 0.340 | 2.9 (no gain: SwiftShader already uses all 10 cores) |
| + `--lite` | **0.122** | **8.2** |
| Old: anime VRM, PNG capture, Intel GPU (`--gpu`) | 0.177 | 5.7 |
| Signer, JPEG capture, Intel GPU | **0.042-0.059** | **17-24** |
| Signer, 4 passes, Intel GPU | 0.126 | 8.0 |
| Signer, 4 passes, software, `--aa 0` | 0.391 | 2.6 |

On software WebGL the cost is rasterising, not capture: `--lite` is 6.8× faster than the old pipeline in the same session. On the GPU it was the PNG round trip: JPEG capture is 3-4× faster.

**Pictures:**
- [`assets/demo/signer/phr-3-old-vs-new.jpg`](../assets/demo/signer/phr-3-old-vs-new.jpg): landmarks | old VRM | new signer at phr-3 frames 40, 63, 100, 140, 200. Made before the palm-flip fix, so frame 63's right hand still bends backwards there.
- [`assets/demo/signer/phr-3-passes.jpg`](../assets/demo/signer/phr-3-passes.jpg): RGB, depth, normal, finger colours at frames 30, 62, 100, 150 (earlier hair).
- [`assets/demo/signer/demo3-finger-worst.jpg`](../assets/demo/signer/demo3-finger-worst.jpg): the metric's 8 worst frames, anime puppet on top, signer below.

**Live player:** [`puppet/src/player.ts`](../puppet/src/player.ts), `SignerPlayer`.
- `create(canvas)`, then `playSentence([motionA, motionB])` joins the signs (blend.ts), solves and plays them on the canvas every screen refresh.
- `npm run build:player` bundles it to `puppet/dist/signer-player.js` (920 KB, three.js included). `player.html?signs=a.json,b.json` is a demo.
- Not timed yet (`scripts/player-check.mjs`).

- **Scores (1 to 5):**
  - Correct signs: not judged.
  - Smooth between signs: not judged.
  - Looks real: 3 for a 3D render. It is a person, not a cartoon, but the face is plain.
  - Speed: above.
  - Cost: $0. No fal or other paid calls.

## What I learned
- **The reference was half the finger problem.** MediaPipe finds the hands in 87% of the signer frames against 39% on the anime puppet, for the same motion. Skin hands on a black top read as hands.
- **The tracker's input is often anatomically impossible.** Most violations are spread and PIP, and whole hands read inside out edge-on. Copying them (`direct`) puts impossible hands into the reference. The limits, the overlap rule and the palm flip catch these. They also move the avatar away from the raw landmarks, by design.
- **Body shape matters for the top.** A tight painted top showed the chest, which the target photo doesn't. Smoothing the chest in the build fixed it.
- **Software WebGL cost is pixels, not capture.** Cheap shading (`--lite`) is what made software rendering fast. More Chrome processes did not help.

## What I'd try next
- Run the heavy jobs on Modal (commands below), then race the signer reference (RGB, depth, normal) through agent C's harness against the anime one. The paid step needs the team's go-ahead.
- Contacts: pull the fingertips to the face or chin when the source touches them. The avatar's proportions still move hands off the face.
- A face closer to the target photo, and real cloth for the top.

## Commands (heavy ones not run on the laptop)

```bash
# build the avatar (Blender 4.2+, ~2 min, downloads ~330 MB once)
node puppet/avatar/build.mjs

# on Modal: upload, render the race reference (HELLO WATER THANK_YOU) and comparisons, grids, benchmark
modal run puppet/modal_render.py::upload --models puppet/models --motions \
  <C>/out/race/demo3/demo3.clean.json,out/realtime/phrases/phr-3.clean.json,out/motion/wlasl/hello-aaf4c6.clean.json,<A>/out/hands3d/demo/hello-aaf4c6.v2.json
modal run puppet/modal_render.py --motions demo3.clean.json,phr-3.clean.json,hello-aaf4c6.clean.json,hello-aaf4c6.v2.json --avatar signer --passes rgb,depth,normal
modal run puppet/modal_render.py --motions demo3.clean.json,phr-3.clean.json,hello-aaf4c6.clean.json --avatar vrm --passes rgb
modal run puppet/modal_render.py::grid --videos phr-3-vrm.mp4,phr-3-signer.mp4 --frames 40,63,100,140,200 --out phr-3-old-vs-new.png
modal run puppet/modal_render.py::grid --videos hello-aaf4c6-vrm.mp4,hello-aaf4c6-signer.mp4,hello-aaf4c6.v2-signer.mp4 --frames 8,16,24,32 --out hello-old-vs-new.png
modal run puppet/modal_render.py::bench --motion phr-3.clean.json
modal run puppet/modal_render.py::probe_gpu
modal volume get signlayer-renders / out/modal
```

`<C>` is agent C's checkout with `out/race/demo3`, `<A>` agent A's with `out/hands3d/demo`.
