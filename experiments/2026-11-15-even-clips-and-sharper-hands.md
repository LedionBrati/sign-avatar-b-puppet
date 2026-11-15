# 2026-11-15: even clips (no wall or head jumps) and sharper hands

**Who:** Ledi (with Claude)
**Question:** why does speech → sign jump between signs (wall colour, head size), and why are the hands sometimes blurry? Can we fix both, cheaply?
**Why it matters:** the app joins pre-made sign clips. Every jump or smeared hand makes the avatar look fake, and a smeared handshape can't be read.

## What causes the jumps

Every H3 Max Recast job picks **its own wall tone and its own zoom**. Clips cut from one job match each other perfectly. Clips from two jobs don't, so a sentence that joins them jumps.

Measured on [`three-sentences-realtime.mp4`](../assets/demo/sentences/three-sentences-realtime.mp4) (16.4 s, 394 frames):
- exactly **2 jumps**, at frames 36→37 and 202→203, where clips from different jobs meet. Everywhere else the wall moves by about 1 level.
- the wall goes from RGB (34, 39, 45) to (27, 32, 39) and back to (33, 39, 45).
- the head is **8% smaller** and its hairline about **20 px lower** in job A than in job B.

## Fix 1: `pipeline/even-clips.mjs` (free, ffmpeg only)

```bash
node pipeline/even-clips.mjs --clips out/realtime/clips --out out/realtime/clips-even
CLIPS_DIR=out/realtime/clips-even node app/server/index.mjs
```

- **Groups clips by job**: clips with the same `source_video` (written by `sign-clips.mjs cut`) are measured together and get **one** correction, so joins inside a job stay seamless.
- **Measures** each job over many frames, taking the median so a hand passing the face doesn't fool it:
  - the wall colour, in the two top corners
  - her face: skin pixels just under the hairline, giving the face width, its centre and the hairline height
- **Corrects** each job to one target look (the most typical job, saved as `even-target.json` so later batches match too):
  1. a colour map per channel, a straight line through wall→wall and skin→skin
  2. a zoom, so the face width matches
  3. a shift, so the hairline and the face centre match
- **Never invents pixels.** If a zoom-out would leave an empty edge, it zooms in a little more instead (+2.4% on one job here). A first version filled edges with a mirror copy, and that **mirrored her fingers** at the bottom edge, so it was removed.
- Originals untouched; the output is a new folder with the same file names, a manifest and `even-report.json` (before, after, what's left over).
- Corrections are capped: zoom 0.85 to 1.18, colour gain 0.85 to 1.18.

**With Nikos's `pipeline/normalize-backgrounds.py`** (merged the same day). It fixes the **wall colour only**, using a person matte, so she is untouched. It does not fix head size or place. They combine:

```bash
python pipeline/normalize-backgrounds.py --src out/realtime/clips --out out/realtime/clips-norm --rvm rvm_mobilenetv3_fp32.onnx
node pipeline/even-clips.mjs --clips out/realtime/clips-norm --out out/realtime/clips-even --color 0
```

Without Python/onnxruntime, `even-clips.mjs` alone (colour on) fixes both. Its colour map touches the whole frame, wall and skin together.

**Result** (5 clips from 3 jobs, joined with `sign-clips.mjs say` as the app does):

| Join | Wall jump before | after |
|---|---|---|
| job A → job B | 18.9 | **3.6** |
| inside job B | 0.1 | 0.4 (still seamless) |
| job B → job C | 16.7 | **1.2** |
| inside job C | 0.3 | 0.4 |

(Sum of R+G+B steps in the wall corners. About 1 level per channel is invisible.)

Left over per job: wall ≤ 2 levels, face size ±1.3%, hairline 0 px, centre ≤ 1 px. Takes about 2 s for 5 clips.

- Stills: [`assets/demo/even/joins-before-after.jpg`](../assets/demo/even/joins-before-after.jpg). Top row before, bottom row after, frames 36 | 37 | 202 | 203.
- Video (not in git): `out/even/three-sentences-before-after.mp4`.
- Note: the test video has a burned-in caption, which gets zoomed along with the clip. Real sign clips have no captions.

## Fix 2: sharper hands (fal)

Same clean puppet (`out/motion/judy.clean.json`, labels off), same avatar, same seed 4242.

**a. 1080P instead of 768P.** Recast's own default is 1080P; our scripts force 768P.
- Hand detail **+27%** (mean |Laplacian| in the hand box), sharper in **142 of 142** frames.
- **Same handshapes** at both sizes.
- In fast moves it only shows the smear in more detail.
- [`assets/demo/even/hands-768p-vs-1080p.jpg`](../assets/demo/even/hands-768p-vs-1080p.jpg): top 768P, bottom 1080P.

**b. Half speed, keep every 2nd frame.** This is the fix for fast moves.

```bash
node pipeline/make-batches.mjs ... --fps 48            # or puppet/compose.mjs --fps 48
node puppet/render.mjs --motion batch-1.clean.json --view vrm --fps 24 --labels 0 --out batch-1.mp4   # plays at half speed
#   Recast batch-1.mp4 at 1080P (2x the seconds)
node pipeline/sign-clips.mjs cut --video recast.mp4 --segments batch-1.json --out-dir out/realtime/clips --every 2
```

- `cutClips({ every: 2 })` in `pipeline/lib/clips.mjs` does the same for code callers. Default `every = 1` changes nothing.
- Composing at 48 fps gives real in-between poses (no duplicated frames).
- Recast copies the half-speed motion with half the blur per frame.
- `cut --every 2` keeps every 2nd frame and halves the segment frame numbers. Checked: every cut frame matches the normal-speed puppet at offset 0.

| | Normal speed, 1080P | Half speed, 1080P, every 2nd frame |
|---|---|---|
| Hand detail, all frames | 3.40 | **3.65** (+8%), sharper in 139/142 |
| Hand detail, fastest 25% of frames | 3.16 | **3.43** (+9%), sharper in 34/36 |
| Output motion follows the puppet (corr.) | 0.58 | **0.65** |

The number undersells it, because it averages the whole chest area. At the 4 fastest frames ([`hands-normal-vs-half-speed.jpg`](../assets/demo/even/hands-normal-vs-half-speed.jpg); rows: puppet, normal, half):
- frames 94 and 95: a **smeared blob** at normal speed becomes a **readable handshape** that matches the puppet
- frame 27: the open hand is clearly crisper
- frame 86: slightly better

Video (not in git): `out/even/judy-normal-vs-half-speed-1080p.mp4`.

**Not used: AI upscalers or sharpeners on the hands.** They can invent fingers, which breaks "never fake a sign".

## Cost

4 Recast jobs on Ledi's account: 768P 5.9 s, 1080P 5.9 s, 1080P 5.9 s, 1080P 11.8 s, so about 30 s in total.

| Request | What |
|---|---|
| `01a1df05-23a9-7bc1-8bdb-9e960849af13` | 768P, debug render |
| `01a1df05-2365-7663-b57c-4ef304a6d424` | 1080P, debug render |
| `01a1df0d-435f-7680-a4ee-57a724738c80` | 1080P, clean, normal speed |
| `01a1df0d-4335-70c3-b28d-5d90fc98c73a` | 1080P, clean, half speed |

The price is **unclear**:
- the README says about $0.085/s
- the E0 harness reserves $0.50/s (768P) and $0.65/s (1080P), as a "conservative planning reserve"
- so this test cost **$2.50 to $18**. Check the fal dashboard.

Half speed doubles the seconds per sign, and 1080P costs more per second.

## What I learned
- The jumps are a **per-job** problem, not a per-clip one. Correct per job, never per clip, or you add small jumps inside a job.
- Fast-move blur is a **motion** problem, not a resolution problem. 1080P helps held handshapes, half speed helps fast ones.
- Never fill an empty edge with mirrored pixels: it mirrored fingers.

## What I'd try next
1. Nikos: run `even-clips.mjs` on the real clip folder (after `normalize-backgrounds.py` if used, with `--color 0`) and point `CLIPS_DIR` at the result (seconds, free).
2. For the mass batches (43 rendered at 24 fps, repaint not run yet): consider 1080P + half speed, at least for signs with fast handshapes (fingerspelling, YOU, LATER). Check the real price first: it doubles the seconds.
3. Have a signer compare normal and half-speed clips of the same sign.
