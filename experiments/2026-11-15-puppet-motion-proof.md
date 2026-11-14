# 2026-11-15: puppet motion proof on Judy (checkpoint 1)

**Who:** Nikos (with Claude)
**Question:** can one real signer clip drive a 3D puppet in the browser, with real signer | landmarks | puppet side by side, and where does it go wrong?
**Why it matters:** checkpoint 1 in README §4, issue #4. Everything after it (finger test, repaint, text → sign) builds on this.

## Setup
- **Input:** `references/how2sign/judy.mp4` (How2Sign, signer 3, CC BY-NC 4.0, 5.9 s, 142 frames at 24 fps).
- **Motion:** `judy.clean.json` from the `nikos/motion` extractor (MediaPipe HolisticLandmarker 1.2.3 plus One Euro cleanup, format `motion/FORMAT.md` v1). That extractor is still in progress, so these numbers get regenerated when it lands.
- **Puppet:** three.js + `@pixiv/three-vrm`, model `VRM1_Constraint_Twist_Sample.vrm` (© pixiv, VRM Public License 1.0, downloaded by `puppet/fetch-model.mjs`, not committed).
- **Solvers compared:**
  - **"direct":** our own; it aims every bone at its landmark.
  - **kalidokit:** the GSL repo's approach.
- **Command:** `node puppet/render.mjs --motion judy.clean.json --view sidebyside --video references/how2sign/judy.mp4 --closeup --out out/puppet/judy-sidebyside.mp4`. Rendering is deterministic, frame by frame in headless Chrome.

## Result
- **Video:** [`assets/demo/puppet/judy-sidebyside.mp4`](../assets/demo/puppet/judy-sidebyside.mp4). Panels: real signer | MediaPipe landmarks with palm normals and hand close-ups | VRM puppet with hand close-ups. 142 frames out for 142 in, checked with ffprobe.
- **Tracking failures** (no landmarks for that part):
  - Left hand: 81 of 142 frames, mostly while it rests on her lap.
  - Right hand: 7 frames (0–6).
  - The puppet falls back to a rest pose for a lost part.
- **Retargeting error** (angle between each avatar bone and its landmark direction):

  | | direct | kalidokit |
  |---|---|---|
  | Arms | 0° | upper arm 15–28°, forearm 26–48° mean |
  | Fingers | 0° | 49–50° mean |
  | Palm | 3.5° mean | 53° mean |

  Direct is about 0° by construction, so that only proves the retargeting copies the landmarks faithfully. It does **not** prove the signing is correct.
- **Kalidokit is not the default.** At frame 90 its arms stay low instead of at the face. Without our axis conversion its errors get worse (about 150°), so the problem is kalidokit's arm solve, not our conversion.
- **Scores (1–5):** not scored. Correct signs need a fluent signer. Looks real does not apply; this is a puppet, before any repaint. Speed: rendering takes about 0.7 s per frame (VRM only) or 1.7 s per frame (side by side) on software WebGL. Cost: free.

## What I learned
- **What carries through:** handshapes from the landmarks reach the puppet, curl **and** spread: index at the chin (frame 45), flat hand by the face with palm to camera (frame 70), index plus pinky (frame 100), index up (frame 135). Left and right are correct.
- **Location drifts.** The avatar's body proportions differ from Judy's, so contacts miss: index at the lips lands below the chin (frame 90), and a hand beside the face lands at shoulder height (frame 100). In ASL, location is meaning. This needs a face-relative or contact-preserving fix (IK toward face landmarks), not just bone directions.
- **Tracking errors pass straight through.** At frame 90 Judy's left hand is a thumbs-up fist, but with her hands overlapping MediaPipe reports open fingers, and the puppet copies that. That's a tracking failure, not a retargeting one (it goes in #2).
- **No joint limits or collisions,** so hands pass through each other when they cross (frame 90).
- **Face:** mouth, blinks and brows come from MediaPipe blendshapes; the head turn comes from the face mesh. Not yet good enough to carry ASL facial grammar.

## What I'd try next
- Contact-preserving hand placement: pull each hand toward the face or body landmarks it touches in the source.
- Hold the last good hand pose through short tracking gaps instead of snapping to rest (with the cleanup in `nikos/motion`).
- Run the same proof on travis (the cleanest Recast result) and on 3 WLASL isolated signs.
- Have a fluent signer look at `judy-sidebyside.mp4` before we call anything correct.
- Then checkpoint 3: repaint `judy-vrm.mp4`, but only after agreeing a budget.
