# Motion file format, v1

One JSON file per clip or sign. Written by `motion/` (Python, MediaPipe) and read by `puppet/` (three.js) and by the shared plan → motion adapter (`shared/`). All sides follow this file; change it here first, by PR.

Files come in pairs:
- `<name>.raw.json`: straight from the tracker, nothing changed.
- `<name>.clean.json`: after cleanup (smoothing, gap filling, trimming). Cleanup can always be redone from the raw file.

```jsonc
{
  "version": 1,
  "name": "judy",                     // file stem
  "motion_id": null,                  // canonical catalog ID (catalog/signs.json), e.g. "HELLO", "THANK_YOU"; null for a sentence clip
  "gloss": null,                      // sign gloss for a dictionary sign ("HELLO"), null for a sentence clip
  "source": {
    "file": "references/how2sign/judy.mp4",
    "dataset": "How2Sign",            // or "WLASL", "own-recording", ...
    "license": "CC BY-NC 4.0",
    "signer": "3",                    // dataset signer id, if known
    "start_s": 0.0,                   // part of the source this file covers
    "end_s": 5.9
  },
  "fps": 24,
  "width": 540,                       // source frame size in pixels (image coords below are 0..1 of this)
  "height": 720,
  "dominant_hand": "right",           // "right" | "left" | null (unknown), the SUBJECT's hand
  "mirrored": false,                  // true if the source was flipped left-right to make it right-dominant
  "extractor": { "name": "mediapipe-holistic-landmarker", "version": "1.2.3", "model": "holistic_landmarker.task float16" },
  "cleaned": false,                   // false in .raw.json, true in .clean.json
  "cleanup": null,                    // in .clean.json: { "smoothing": "one-euro", "params": {...}, "trim": [startFrame, endFrame], "filled_frames": {...} }
                                      //   trim: first and last kept frame of the RAW file, both inclusive; frames are renumbered from i=0, t=0
                                      //   filled_frames: { "leftHand": [i, ...], ... } frame indices in THIS file that were interpolated
  "frames": [
    {
      "i": 0,                         // frame index in this file
      "t": 0.0,                       // seconds from start of this file
      "pose":           [[0.51, 0.32, -0.41, 0.99], ...],  // 33 x [x, y, z, visibility]; x,y in 0..1 image coords, y down
      "poseWorld":      [[0.01, -0.55, -0.12], ...],       // 33 x [x, y, z] metres, origin between the hips, y down
      "face":           [[0.50, 0.21, -0.02], ...],        // 478 x [x, y, z] image coords (468 mesh + 10 iris)
      "faceBlendshapes": { "browInnerUp": 0.12, ... },     // 51 ARKit-style scores 0..1 (MediaPipe has no tongueOut; its "_neutral" is dropped), optional
      "leftHand":       [[0.62, 0.55, -0.01], ...],        // 21 x [x, y, z] image coords, subject's LEFT hand
      "leftHandWorld":  [[0.05, -0.24, -0.31], ...],       // 21 x [x, y, z] metres, SAME frame as poseWorld (origin between the hips); point 0 = poseWorld 15, optional
      "rightHand":      [[...], ...],                      // 21 points, subject's RIGHT hand
      "rightHandWorld": [[...], ...]                       // point 0 = poseWorld 16
    }
  ]
}
```

## Rules
- **A part that isn't detected in a frame is `null`,** never zeros. Cleanup may fill it; `cleanup.filled_frames` lists what was filled.
- **Left and right always mean the subject's own hands,** whatever the camera does. If the source was mirrored, the labels are swapped to match, and `mirrored` is true.
- **Numbers are rounded to 4 decimals**, to keep files small.
- **Landmark indices follow MediaPipe:**
  - pose: 33 points (0 nose, 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips).
  - hand: 21 points (0 wrist, 4 thumb tip, 8 index tip, …).
  - face: 478 points.
- **`fps` is the frame rate of the data,** which can differ from the source video's.
- **`motion_id` matches the sign's entry in `catalog/signs.json`.** The catalog's `motion_path` points at the `.clean.json` file. The motion file never decides whether a sign is verified; the catalog does.
- **The recognizer needs an adapter.** The sign-recognition models expect the legacy 543-point layout (468 face points, no iris), so the adapter drops face points 468–477 and reorders the parts. That conversion lives in the recognizer, not in this format.
