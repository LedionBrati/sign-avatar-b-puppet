// Sign -> voice: pack MediaPipe Holistic landmarks into the layout the pretrained recognizers expect.
//
// The Kaggle GISLR / fingerspelling models were trained on the LEGACY MediaPipe Holistic layout:
//   543 points = face 0-467 | left hand 468-488 | pose 489-521 | right hand 522-542, each [x, y, z], NaN when missing.
// The current @mediapipe/tasks-vision HolisticLandmarker returns a 478-point face (468 mesh + 10 iris):
// we drop the iris points 468-477. "left"/"right" are the SUBJECT's hands, so feed UNMIRRORED frames
// (mirror only the preview the user sees).

export const LEGACY_POINTS = 543;
export const FACE_POINTS = 468;
export const HAND_POINTS = 21;
export const POSE_POINTS = 33;
export const OFFSETS = { face: 0, leftHand: 468, pose: 489, rightHand: 522 } as const;
/** Models were trained on up to 384 frames; clients cap segments at this length. */
export const MAX_FRAMES = 384;

export interface Point { x: number; y: number; z?: number }

/** One frame from HolisticLandmarker (first detected person), any part may be missing. */
export interface HolisticFrame {
  face?: Point[] | null; // 478 (or 468)
  leftHand?: Point[] | null; // 21
  pose?: Point[] | null; // 33
  rightHand?: Point[] | null; // 21
}

/** Pack one frame into a Float32Array(543 * 3), NaN for missing parts. */
export function packFrame(f: HolisticFrame, out = new Float32Array(LEGACY_POINTS * 3)): Float32Array {
  out.fill(NaN);
  const put = (pts: Point[] | null | undefined, offset: number, count: number) => {
    if (!pts) return;
    for (let i = 0; i < count && i < pts.length; i++) {
      const p = pts[i]!;
      const k = (offset + i) * 3;
      out[k] = p.x;
      out[k + 1] = p.y;
      out[k + 2] = p.z ?? 0;
    }
  };
  put(f.face, OFFSETS.face, FACE_POINTS); // drops iris 468-477
  put(f.leftHand, OFFSETS.leftHand, HAND_POINTS);
  put(f.pose, OFFSETS.pose, POSE_POINTS);
  put(f.rightHand, OFFSETS.rightHand, HAND_POINTS);
  return out;
}

/** Concatenate packed frames into one body for POST /api/recognize (frames x 543 x 3 float32). */
export function packSegment(frames: Float32Array[]): Float32Array {
  const n = Math.min(frames.length, MAX_FRAMES);
  const body = new Float32Array(n * LEGACY_POINTS * 3);
  for (let i = 0; i < n; i++) body.set(frames[i]!, i * LEGACY_POINTS * 3);
  return body;
}

/** True if either hand is present in a holistic frame. Used for auto start/stop of a sign segment. */
export const handsVisible = (f: HolisticFrame) => Boolean(f.leftHand?.length || f.rightHand?.length);
