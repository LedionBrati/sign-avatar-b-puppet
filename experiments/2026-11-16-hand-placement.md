# 2026-11-16: hand placement on the realistic signer

**Who:** Nikos (with Claude)
**Question:** why does the new signer avatar put its hands beside its head when the source touches the eye, ear or chin, and can we fix that without changing the anime VRM?
**Why it matters:** in ASL the location is part of the sign (chin, forehead, chest, the other hand). A hand that floats 10 cm beside the face changes or loses the sign.

## Setup
- Inputs: phr-3 (`out/realtime/phrases/phr-3.clean.json`, 248 frames), HELLO (`out/motion/wlasl/hello-aaf4c6.clean.json`, 41), demo3 (`out/race/demo3/demo3.clean.json`, 133).
- Avatars: `signer.glb` (anatomic hands) and the anime `VRM1_Constraint_Twist_Sample.vrm` as the reference.
- Branch `fix/hand-placement` (from `finals/integration`). Code: `puppet/src/place.ts` (new), `puppet/src/vrm.ts`, `puppet/src/avatar.ts`, `puppet/render.mjs`, `puppet/modal_render.py`.
- Commands, all on Modal (CPU, `--lite`), from the repo root:
  - before: `modal run puppet/modal_render.py::main --motions phr-3.clean.json,hello-aaf4c6.clean.json,demo3.clean.json --placement fk --tag fk --passes rgb`
  - after: `modal run puppet/modal_render.py::main --motions <same> --tag ik --passes rgb,depth,normal`
  - reference: `modal run puppet/modal_render.py::main --motions <same> --avatar vrm`
- Outputs downloaded to `out/modal/renders-fixed/`.

## Cause
The arms were retargeted by copying bone directions. That part works: upper arm and forearm direction error was under 1 degree. But the same directions put the hands in different places on a body with different proportions. The signer's head sits about 0.20 m above its shoulder joints, while the source's nose is 0.16 m above its shoulders in poseWorld. Its face is also nearer the shoulder plane than the tracker's face. So a fingertip on the source's eye lands beside the signer's temple. The anime VRM only looked right by chance: its big head is low and close to its short shoulders.

A second problem showed up while measuring. The tracker's depth can't be trusted near the face. In phr-3 a hand that touches the eye in the video comes out about 15 cm in front of the nose in poseWorld.

## Fix
1. Source points go into a "location space": x and y come from the image landmarks (exact in the picture), scaled to metres, and z comes from poseWorld. The face points come from the face mesh: nose tip, chin, eyes, and the face outline at the ears.
2. The avatar's own face points are found once from its meshes at load (eye meshes, the most forward midline skin point, the lowest forward midline point, the widest head points). They are kept in the head bone's frame.
3. The wanted wrist position starts from a base: the wrist's frontal offset from the sternum in shoulder widths, at the depth that keeps the copied arm's reach. Each hand point near a face point (wrist and the 5 fingertips) then pulls the wrist so that point lands at the same offset from the avatar's face point. Offsets are scaled by head width, and depth is mostly the face's. The weights are inverse-distance to the 4th power, so the blend is smooth.
4. When the two hands touch in the source, the closest pair of points keeps its offset. A hand that would go into the face is pushed forward onto it (head ellipsoid).
5. Two-bone IK solves upper arm and forearm. The tracked elbow is the pole, so the swivel is kept. The hand keeps its tracked world orientation, so the anatomic fingers and palm are unchanged.

This is on by default for glTF avatars (`--placement auto`). The VRM keeps `fk`, so its output is unchanged.

## Result
New report block `location`. For each tracked hand-frame it compares the frontal-plane distance from the wrist and the index tip to the nose, chin and each shoulder, in shoulder widths, source vs avatar. A face contact is a source hand-frame with a hand point within 0.15 shoulder widths of a face point. It counts as lost when the avatar's nearest point is further than 0.15.

| clip | avatar | mean err | max err | contacts | lost | lost by > 0.25 | 3D gap at contacts |
|---|---|---|---|---|---|---|---|
| phr-3 | VRM (ref) | 0.222 | 1.41 | 35 | 25 | 14 | 0.91 |
| phr-3 | signer before | 0.145 | 1.00 | 35 | 29 | 25 | 0.68 |
| phr-3 | signer after | **0.064** | **0.54** | 35 | **10** | **0** | **0.19** |
| HELLO | VRM (ref) | 0.134 | 0.68 | 13 | 3 | 1 | 0.68 |
| HELLO | signer before | 0.181 | 0.49 | 13 | 11 | 3 | 0.53 |
| HELLO | signer after | **0.061** | **0.26** | 13 | **0** | 0 | **0.17** |
| demo3 | VRM (ref) | 0.187 | 1.04 | 42 | 31 | 14 | 0.88 |
| demo3 | signer before | 0.166 | 0.49 | 42 | 41 | 17 | 0.67 |
| demo3 | signer after | **0.083** | 0.50 | 42 | **1** | 0 | **0.13** |

- The 10 contacts still lost in phr-3 are all near the threshold: the source is 0.12-0.15 and the avatar is 0.15-0.20 (it was 0.2-0.5 before).
- "3D gap" is the avatar's real 3D distance from hand to face at source contacts. After the fix the hands touch the face. Before (and on the VRM) they hovered 15-25 cm in front of it.
- Joint-limit violations: still 0. The arm "retargeting error" in degrees goes from under 1 to about 28-37 mean. That's expected: the arm no longer copies the tracker's bone directions, it reaches the location instead.
- Speed: phr-3 went from 0.029 to 0.061 s/frame on Modal CPU (the pass count also went from 1 to 3).
- Frame strip (old VRM / signer before / signer after, phr-3 frames 36, 63, 100, 140, 200): `out/modal/renders-fixed/phr-3-strip-vrm-before-after.jpg`. At 63 and 140 the fingertip is now at the eye. At 100 and 200 the hands are closer to the head, like the source.
- demo3 with the fix, for the fal race: `out/modal/renders-fixed/demo3-signer-ik.mp4`, `.depth.mp4`, `.normal.mp4`.

## What I learned
- Copying angles exactly is not the same as signing correctly. Location has to be solved in positions relative to the avatar's own face.
- The tracker's depth is the weakest signal near the face. The frontal picture plus "touching means at the face" is closer to what a viewer sees.
- The metric's VRM numbers depend on face points read off an anime mesh, so use them only as a rough reference.

## What I'd try next
- When the hand is at the eye, the forearm sometimes crosses in front of the lower face (phr-3 frames 63, 140). The elbow pole could be lifted out to the side when the target is near the face.
- Chest contacts use only the shoulder-based base. A chest surface anchor (and push-out, like the head) would make hand-on-chest signs exact.
- Re-run the fal race on the new demo3 passes and compare.

## Follow-up (same day): face stays visible, no palm flips, WiLoR v2 hands

**Question:** after the first fix, the forearm crossed the nose and mouth when a hand touched the eye (phr-3 frames 63, 140), and the owner saw wrong frames. Can we keep the face visible and remove palm flips?

### What changed
- **Arm out of the face.** Two things together:
  - Near the face, the hand is turned so wrist-to-knuckles points where the source's does relative to the face. The tracker's 3D hand direction is least reliable there, and copied as is it left the wrist and forearm across the nose.
  - The elbow swivel is searched around the IK circle. The cost is the arm covering the face in the render camera, plus penalties for an elbow above or behind the shoulder or inside toward the midline. The solver is pulled toward the tracked swivel and the previous frame's.
  - `--swivel 0` turns both off (= ik v1).
- **No palm flips** (`puppet/src/handtrack.ts`). Each hand's orientation over the clip is cleaned as one sequence:
  - one quaternion hemisphere;
  - short runs that jump more than 90 degrees from both neighbours, where the neighbours agree with each other, are rejected as tracker flips;
  - turns are limited to 720 degrees per second;
  - untracked spans are filled by slerp (finger angles linearly) with a one-frame hold at each edge, up to 1 s;
  - next to longer gaps the last good pose is held for 0.25 s.
  - `--handclean 0` gives the old frame-by-frame hands.
- **WiLoR v2 motions.** The renderer already prefers `hands3d`. `blend.ts` now carries `hands3d` through the cross-blend, so `compose.mjs` keeps it. demo3 was rebuilt from the v2 files of its three signs: `out/motion/wlasl3d/hands3d/{hello-aaf4c6,water-6d5a45,thank_you-897a1c}.v2.json` -> `out/modal/renders-fixed/demo3-v2.clean.json` (122 frames; the old demo3 used other takes of the same signs, 133 frames).
- **New report blocks.**
  - `quality`: bad frames over the lead's thresholds (palm or hand direction > 60, fingers > 50, upper arm or forearm > 45 degrees), split into hand and arm. Palm flips = frames where the avatar's own palm normal turns more than 90 degrees from the previous frame.
  - `occlusion`: how many of 8 face points (eyes, nose, mouth, chin, forehead, cheeks) an upper arm or forearm covers in the camera. Points within 3.5 cm of a finger are left to the hand.

### Numbers (Modal)
"base" is ik v1 with frame-by-frame hands on the v1 motions. It reproduces the lead's count of 91/17/48 bad frames.

| clip | version | bad frames | of which hand | of which arm | palm flips | location err | contacts lost | arm covers face (frames) |
|---|---|---|---|---|---|---|---|---|
| phr-3 (v1 only) | base | 92 / 248 | 34 | 73 | 2 | 0.064 | 10 / 35 | 2 |
| phr-3 (v1 only) | v3 | 88 / 248 | 39 | 62 | **0** | 0.066 | 8 / 35 | **0** |
| HELLO | base (v1) | 17 / 41 | 3 | 14 | 1 | 0.061 | 0 / 13 | 0 |
| HELLO | v3 (v2 file) | **7 / 41** | **0** | 7 | **0** | 0.062 | 0 / 13 | 0 |
| demo3 | base (v1) | 46 / 133 | 6 | 41 | 1 | 0.084 | 1 / 42 | 0 |
| demo3 | v3 (from v2 signs) | 39 / 122 | **0** | 39 | **0** | 0.085 | 1 / 42 | 0 |

- **Palm flips are 0 everywhere.** With v2 hands, no bad hand frames remain. HELLO f37-38 fingers drop from 60-94 to 7 degrees.
- **Remaining "arm" bad frames are mostly by design.** IK placement leaves the tracker's arm direction to reach the location, so the 45-degree arm threshold flags it. It is not a visual error; the location error shows whether the arm is right.
- **Remaining hand bad frames in phr-3 are against wrong landmarks.** phr-3 has no v2 file. At f96-100 its left-hand landmarks are themselves inside out: the solver detects this, and the avatar's palm stays continuous (0 flips). The "177 degrees" is measured against those wrong landmarks. f141 and f233 are rejected tracker flips, filled from the neighbours.
- **The occlusion metric is coarse.** It is a few points and two capsules, so it understates how bad v1 looked (2 frames). The frame strip shows the change better.

### Files (`out/modal/renders-fixed/`)
- Strip, old VRM / ik v1 / v3, phr-3 frames 36, 63, 100, 140, 200: `phr-3-strip-vrm-ikv1-v3.jpg`. At 63 and 140 the forearm now comes up from the side, the hand is at the eye, and the face is clear.
- v3 renders:
  - `phr-3-signer-v3.mp4` / `.depth.mp4`
  - `hello-aaf4c6.v2-signer-v3.mp4` / `.depth.mp4`
  - `demo3-v2-signer-v3.mp4` / `.depth.mp4` / `.normal.mp4`
- Reports: the matching `.json` next to each video, `*-signer-base.json` for the baseline.
