"""Second look at the hands Holistic missed: crop around the pose model's hand, zoom, re-track.

    from redetect import hand_box, redetect_hands

Holistic finds the body in ~100% of frames but loses a hand in blurred, fast or touching frames.
The pose model still knows roughly where each hand is (pose points 15-22: wrist, pinky, index,
thumb). Here we cut a square around that spot, upscale it, and run MediaPipe's stand-alone
HandLandmarker (IMAGE mode, free, Apache-2.0) on it. A detection is kept only if its wrist is
close to the pose wrist of the right side and closer to it than to the other wrist.

hands_gpu.py uses tighter boxes from the same pose points (WiLoR pads its box itself).
"""
from __future__ import annotations

import urllib.request
from pathlib import Path

import cv2
import numpy as np

from common import MODELS_DIR

HAND_MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
                  "hand_landmarker/float16/latest/hand_landmarker.task")
HAND_MODEL_PATH = MODELS_DIR / "hand_landmarker.task"

POSE_HAND = {"left": (15, 17, 19, 21), "right": (16, 18, 20, 22)}  # wrist, pinky, index, thumb
CROP_PX = 320  # crop side after upscaling
MIN_SCORE = 0.5
MAX_WRIST_DIST = 0.6  # accepted wrist distance from the pose wrist, as a fraction of the crop side


def ensure_hand_model(path: Path = HAND_MODEL_PATH) -> Path:
    if path.exists() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    print(f"downloading {HAND_MODEL_URL} -> {path}")
    urllib.request.urlretrieve(HAND_MODEL_URL, tmp)
    tmp.replace(path)
    return path


def hand_box(frame: dict, side: str, W: int, H: int) -> tuple[float, float, float] | None:
    """(cx, cy, side_px) square around a hand. Uses the hand landmarks if present, else the pose
    hand points. None if the pose wrist is not visible."""
    hand = frame.get(f"{side}Hand")
    if hand is not None:
        p = np.array(hand)[:, :2] * [W, H]
        lo, hi = p.min(0), p.max(0)
        c = (lo + hi) / 2
        s = max(hi - lo) * 1.6
        return float(c[0]), float(c[1]), float(max(s, 48.0))
    pose = frame.get("pose")
    if pose is None:
        return None
    P = np.array(pose, dtype=float)
    w, pk, ix, th = (P[k] for k in POSE_HAND[side])
    if w[3] < 0.3:
        return None
    wp = w[:2] * [W, H]
    kn = (pk[:2] + ix[:2]) / 2 * [W, H]
    d = kn - wp
    L = float(np.hypot(*d))
    sw = float(np.hypot(*((P[11, :2] - P[12, :2]) * [W, H])))
    c = wp + 1.1 * d  # the hand's middle sits about one wrist->knuckle length past the knuckles
    s = float(np.clip(5.0 * L, 0.7 * sw, 1.6 * sw))  # the palm detector needs context around the hand
    return float(c[0]), float(c[1]), s


def crop(rgb: np.ndarray, box, out_px: int = CROP_PX):
    """Square crop (padded with black at the edges), resized to out_px. Returns (crop, x0, y0, scale)."""
    cx, cy, s = box
    x0, y0 = int(round(cx - s / 2)), int(round(cy - s / 2))
    S = int(round(s))
    H, W = rgb.shape[:2]
    pad = np.zeros((S, S, 3), dtype=rgb.dtype)
    xa, ya, xb, yb = max(x0, 0), max(y0, 0), min(x0 + S, W), min(y0 + S, H)
    if xb > xa and yb > ya:
        pad[ya - y0:yb - y0, xa - x0:xb - x0] = rgb[ya:yb, xa:xb]
    sc = out_px / S
    return cv2.resize(pad, (out_px, out_px), interpolation=cv2.INTER_CUBIC), x0, y0, sc


def read_frames(video: str | Path, wanted: set[int], mirror: bool = False) -> dict[int, np.ndarray]:
    """RGB frames by index (sequential read, like extract.py, so indices match the raw file)."""
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {video}")
    out, i = {}, 0
    last = max(wanted) if wanted else -1
    while i <= last:
        ok, bgr = cap.read()
        if not ok:
            break
        if i in wanted:
            if mirror:
                bgr = cv2.flip(bgr, 1)
            out[i] = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        i += 1
    cap.release()
    return out


def make_hand_landmarker():
    import mediapipe as mp  # noqa: F401
    from mediapipe.tasks.python import BaseOptions, vision

    opts = vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(ensure_hand_model())),
        running_mode=vision.RunningMode.IMAGE,
        num_hands=2,
        min_hand_detection_confidence=0.3,
        min_hand_presence_confidence=0.3,
    )
    return vision.HandLandmarker.create_from_options(opts)


def redetect_hands(video: str | Path, raw: dict, todo: list[tuple[int, str]]) -> dict:
    """Re-track the (raw frame index, side) pairs in `todo`.

    Returns {(i, side): {"image": 21x[x,y,z] (0..1 of the full frame, like FORMAT v1),
    "world": 21x[x,y,z] metres (hand-centred, camera axes), "score": float}} for accepted hands."""
    import mediapipe as mp

    W, H = raw["width"], raw["height"]
    frames = {f["i"]: f for f in raw["frames"]}
    rgbs = read_frames(video, {i for i, _ in todo}, mirror=bool(raw.get("mirrored")))
    out = {}
    with make_hand_landmarker() as lm:
        for i, side in todo:
            f = frames.get(i)
            if f is None or i not in rgbs or f.get("pose") is None:
                continue
            box = hand_box({"pose": f["pose"]}, side, W, H)  # pose-based box: the old hand points may be wrong
            if box is None:
                continue
            img, x0, y0, sc = crop(rgbs[i], box)
            r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(img)))
            if not r.hand_landmarks:
                continue
            P = np.array(f["pose"], dtype=float)
            me = P[POSE_HAND[side][0], :2] * [W, H]
            other = P[POSE_HAND["right" if side == "left" else "left"][0], :2] * [W, H]
            best = None
            for k, hl in enumerate(r.hand_landmarks):
                score = float(r.handedness[k][0].score) if r.handedness and r.handedness[k] else 0.0
                pts = np.array([[l.x, l.y, l.z] for l in hl])
                full = np.empty_like(pts)
                full[:, 0] = (pts[:, 0] * CROP_PX / sc + x0)
                full[:, 1] = (pts[:, 1] * CROP_PX / sc + y0)
                full[:, 2] = pts[:, 2] * CROP_PX / sc  # same scale as x, in pixels
                d_me = float(np.hypot(*(full[0, :2] - me)))
                d_other = float(np.hypot(*(full[0, :2] - other)))
                if score < MIN_SCORE or d_me > MAX_WRIST_DIST * box[2] or d_other < d_me:
                    continue
                if best is None or d_me < best[0]:
                    world = np.array([[l.x, l.y, l.z] for l in r.hand_world_landmarks[k]])
                    best = (d_me, full, world, score)
            if best is None:
                continue
            _, full, world, score = best
            img_pts = np.stack([full[:, 0] / W, full[:, 1] / H, full[:, 2] / W], axis=1)
            out[(i, side)] = {"image": img_pts.tolist(), "world": world.tolist(), "score": score}
    return out
