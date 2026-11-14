# First real motion integration — 15 Nov 2026

## Outcome

Nikos's `motion/` and `puppet/` code are merged into `main` (PRs #16 and #15). A real isolated WLASL `HELLO` clip was extracted locally, cleaned, loaded unchanged through `loadPlayback()`, and visibly animated by Nikos's VRM renderer. A local `HELLO → THANK_YOU` two-clip sequence also rendered. **This is a technical playback proof, not signer-verified ASL or permission to ship the source clips.** No WLASL video, derived motion JSON, or temporary catalog entry is committed.

## Sources and rights

- `HELLO`: WLASL v0.3 video ID `27172`, signer ID `46`, SignSchool source. The original URL is recorded in [WLASL's metadata](https://github.com/dxli94/WLASL/blob/master/start_kit/WLASL_v0.3.json).
- `THANK_YOU`: WLASL v0.3 video ID `57655`, signer ID `46`, same source.
- [WLASL's license page](https://dxli94.github.io/WLASL/) describes C-UDA and academic/computational use only, with no commercial use. The original SignSchool clip terms and permission to redistribute derived motion need review. No fluent signer has reviewed either avatar output. Both clips stayed local; the real `catalog/signs.json` remains empty.
- Judy is a How2Sign sentence reference (`motion_id: null`), not an isolated sign. It was used only to reproduce Nikos's source | skeleton | VRM comparison.

## Reproduction and compatibility

Using PR #16's pinned `motion/uv.lock` and official MediaPipe model, `uv sync --locked`, `fetch_model.py`, `extract.py`, `clean.py`, and `report.py` ran locally. Judy produced 142 frames at 24 fps. `HELLO` produced 69 raw frames and 48 cleaned frames (trim `[8,55]`) at 29.97 fps. `THANK_YOU` produced 75 raw and 36 cleaned frames (trim `[26,61]`) at 29.97 fps. The source videos are **not** copied into this repository.

All three clean files passed our `assertMotionV1()` and Nikos's `validateMotion()` with no warnings. Maximum timestamp deviation from `i/fps` was under 0.000035 s. In every tracked hand-world frame checked, hand point 0 equaled the corresponding `poseWorld` wrist exactly (left wrist 15, right wrist 16), matching the updated `motion/FORMAT.md`. The source and puppet views show the right hand on the correct side. `mirrored` was false for all three; real left-handed mirroring remains untested.

The opt-in real-file test can be run against the locally extracted `HELLO` file from the repository root:

```sh
ASL_REAL_MOTION_ROOT="$PWD" \
ASL_REAL_MOTION_PATH=out/motion/hello-27172.clean.json \
ASL_REAL_MOTION_ID=HELLO ASL_REAL_MOTION_GLOSS=HELLO \
node --test shared/real-motion.integration.test.mjs
```

It checks the real file's ID, gloss, v1 structure, and that `loadPlayback()` returns the same object. The test's in-memory `verified` entry is **technical wiring only** and is never added to the product catalog. The PR #14 CLI also returned `ready` for this local entry with right-hand detection in 44/48 frames, pose and face in 48/48, and no left-hand detection (the left hand rests throughout the source). For `THANK_YOU`, it returned 34/36 right-hand frames.

Nikos's `puppet/render.mjs` accepted the object serialized from `loadPlayback()`; parsed JSON before and after serialization had the same SHA-256 (`f8529b2fe9dda6b443c1b1ec60280af4fdc82e40336ba7a12eb6759c769d4b9e`). The renderer wrote a 48-frame, 1620×720, 29.97 fps source | skeleton | VRM comparison. Visual inspection of frames 5, 21, and 39 showed the hand rise, forehead contact region, and outward wave on the VRM. The renderer reported 4 missing right-hand frames and 48 missing left-hand frames; its direct solver reported a 4.2° mean right-palm error. The model and source have different body proportions, so contact and handshape fidelity still need signer review.

For the two-item local plan, `loadPlayback()` returned ordered `HELLO` and `THANK_YOU` objects. Nikos's `concatClips()` blended them over 0.2 s into 78 frames, and `render.mjs --view vrm` wrote a 540×720, 29.97 fps video. I inspected frames 21, 46, and 66. This proves the technical sequence path only; it does not validate ASL grammar or the transition. The blender's result is a **runtime composite**, not a catalog `.clean.json` asset: it sets `motion_id: null` while retaining a combined gloss and nullable source metadata, so it should not be passed back through the strict isolated-asset loader.

## Judy reproduction and limitations

Judy extraction, cleanup, finger report, and full 142-frame source | skeleton | VRM render succeeded. The report found right-hand detection in 90.8% of raw frames and 94.2% of active frames, with 8 active right-hand losses; left-hand detection was 40.8% overall and 95.1% while active. The renderer reported 81 missing left-hand frames and 7 missing right-hand frames. I inspected frames 46, 91, and 136. At frame 91, the avatar's hand contact is below the signer's mouth contact, matching the limitation Nikos recorded in PR #15. The direct solver's low angle error measures its fit to landmarks, not ASL correctness.

The first `report.py` attempt failed because `ffmpeg` was not on `PATH`; rerunning with the existing local E0 `ffmpeg-static` binary succeeded. No extractor or player code change was needed. No fal or other paid model was called.

## Remaining product gates

1. Confirm SignSchool source permissions and WLASL C-UDA fit the intended demo and any distribution. Keep local motions out of the repository until that is resolved.
2. Have a fluent/Deaf ASL reviewer inspect the source, extraction, rendered handshape, palm direction, forehead contact, and two-sign transition before setting any real catalog entry to `verified`.
3. Ledi's unified frontend interface is not yet published. When available, send `ready.items[n].motion` to Nikos's player in order and preserve the shared `unsupported` result with no partial playback.
