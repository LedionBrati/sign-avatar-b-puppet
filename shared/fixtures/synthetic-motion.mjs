// Synthetic non-ASL wiring fixture. Values are repeated placeholders, never a sign.
export function syntheticMotion({ cleaned = true, sentence = false } = {}) {
  const pose = () => Array.from({ length: 33 }, () => [0.5, 0.5, 0, 1]);
  const poseWorld = () => Array.from({ length: 33 }, () => [0, 0, 0]);
  const face = () => Array.from({ length: 478 }, () => [0.5, 0.5, 0]);
  const hand = () => Array.from({ length: 21 }, () => [0.5, 0.5, 0]);
  return {
    version: 1, name: "SYNTHETIC", motion_id: sentence ? null : "SYNTHETIC",
    gloss: sentence ? null : "SYNTHETIC",
    source: { file: "synthetic-non-asl.mp4", dataset: "synthetic test fixture", license: "test-only",
      signer: null, start_s: 0, end_s: 2 / 24 },
    fps: 24, width: 540, height: 720, dominant_hand: "right", mirrored: false,
    extractor: { name: "synthetic", version: "test", model: "none" },
    cleaned, cleanup: cleaned ? { smoothing: "none", params: {}, trim: [0, 1], filled_frames: {} } : null,
    frames: [
      { i: 0, t: 0, pose: pose(), poseWorld: poseWorld(), face: face(),
        leftHand: null, leftHandWorld: null, rightHand: hand(), rightHandWorld: hand(),
        faceBlendshapes: { browInnerUp: 0 } },
      { i: 1, t: 1 / 24, pose: pose(), poseWorld: poseWorld(), face: null,
        leftHand: hand(), rightHand: null, rightHandWorld: null },
    ],
  };
}
