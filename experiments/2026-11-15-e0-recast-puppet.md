# 2026-11-15: E0, H3 Max Recast on the puppet (checkpoint 3)

**Who:** Nikos (with Claude)
**Question:** does `minimax/h3-max/recast` repaint a 3D puppet into our realistic avatar as faithfully as it repaints a real person? (Issue #1, README §6.1.)
**Why it matters:** Method B only works if the repaint keeps the signs. If it changes handshapes, the README fallback applies (Recast on real signer clips only).

## Setup
- **Puppet:** `judy-vrm.mp4` from PR #15 (the "direct" solver, VRM sample model), 540×720, 24 fps, 142 frames, 5.92 s. It's driven by the Judy motion from PR #16.
- **Source for comparison:** `references/how2sign/judy.mp4` (How2Sign, signer 3, CC BY-NC 4.0). Source and puppet alignment: 0 frame delta.
- **Avatar:** `assets/avatar/avatar-main.jpg`.
- **Model:** `minimax/h3-max/recast`, 768P, no prompt, safety checker on, seed 765790012. Request `01a1dc75-74f2-7a50-8237-1329a6502a25`.
- **Command** (Alex's gated harness, PR #11):
  ```bash
  node pipeline/e0.mjs --puppet judy-vrm.mp4 --source references/how2sign/judy.mp4 \
    --model recast --execute --authorize-paid E0-PAID --max-usd 5
  ```
- Kling was planned as a second candidate but not run, by choice: we're testing H3 Max only.

## Result
- **Video:** [`assets/demo/e0/judy-recast-comparison.mp4`](../assets/demo/e0/judy-recast-comparison.mp4). Panels: real signer | puppet | realistic avatar.
- **Time:** **90 s** of fal time for 5.92 s of video (about 15 s per second of video), the same rate as day one on a real signer.
- **Cost:** harness reserve $2.96 (conservative). The actual billed amount isn't in the API response; check the fal dashboard.
- **Output:** 768×1024, 24 fps, **142 frames, the same as the input**. Timing is 1:1 (Δframes 0).
- **It accepts the cartoon puppet as a person.** The output is our realistic avatar, on the dark wall from the avatar photo, so **no background removal is needed** (Recast took the background from the source on day one; the puppet's plain backdrop seems to let the avatar's wall through).
- **Fingers come out crisp,** sharper than the motion-blurred source frames.

Hand check against the real signer (crops at frames 45, 100 and 135):

| Frame | Real signer | Puppet | Repaint | Verdict |
|---|---|---|---|---|
| 45 | Index finger touching the chin | Index near the chin | Hand at the chest, index curled | ✗ handshape **and** location lost |
| 70 | Flat hand by the face, palm to camera | Same, lower | Flat hand by the shoulder, palm to camera | handshape ✓, location low |
| 90 | Index at the lips + left thumbs-up | Hands crossed at the chest | Hands crossed at the chest | copies the puppet's error |
| 100 | Thumb + index + pinky out, at the face | Index up, at the chin | Index + pinky out, at the chest | handshape close, location low |
| 135 | Index up, at the face | Index up | Index up, clear | handshape ✓, location low |

- **Scores (1–5):**
  - Correct signs: **not judged**; this needs a fluent signer.
  - Looks real: 5. It looks like a real video of the avatar.
  - Speed: 90 s of fal time.
  - Cost: ≤ $2.96.

## What I learned
- **The repaint isn't the weak link. It follows the puppet,** including the puppet's mistakes. Wherever the puppet is right, the repaint keeps the handshape. Where the puppet is wrong, the repaint is wrong in the same way.
- **The main problem is hand location.** Hands land at chest height instead of at the face throughout, because the puppet's body proportions differ from the signer's (see the puppet log, PR #15). In ASL, location carries meaning, so this has to be fixed in the puppet: keep contacts such as finger at the chin or finger at the lips.
- **Frame 45 is a real repaint loss on top of that:** a finger touching the face gets curled into a fist. That's worth watching once the location fix is in.
- Facial expression is weak, because the puppet's face only gets blinks, brows and mouth.

## What I'd try next
1. **Contact-preserving puppet:** pull hands toward the face or body landmarks they touch in the source. Then re-run this exact test and compare.
2. **Sentences, not single clips:** join 2–3 WLASL signs into one motion with `puppet/src/blend.ts`, then render and Recast the whole sentence. That's the actual product path.
3. A fluent signer reviews `judy-recast-comparison.mp4` before anyone calls it correct.
