"""Shared helpers: model download, rounding, JSON IO, landmark access."""
from __future__ import annotations

import json
import math
import re
import urllib.request
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
MODELS_DIR = HERE / "models"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/"
    "holistic_landmarker/float16/latest/holistic_landmarker.task"
)
MODEL_PATH = MODELS_DIR / "holistic_landmarker.task"
MODEL_LABEL = "holistic_landmarker.task float16"

FORMAT_VERSION = 1
DECIMALS = 4

# Frame keys holding landmark lists, per FORMAT.md v1.
IMAGE_PARTS = ("pose", "face", "leftHand", "rightHand")
WORLD_PARTS = ("poseWorld", "leftHandWorld", "rightHandWorld")
ALL_PARTS = IMAGE_PARTS + WORLD_PARTS
HAND_PARTS = ("leftHand", "rightHand")

# MediaPipe pose indices
NOSE, L_SHOULDER, R_SHOULDER = 0, 11, 12
L_ELBOW, R_ELBOW, L_WRIST, R_WRIST = 13, 14, 15, 16
L_HIP, R_HIP = 23, 24
POSE_WRIST = {"leftHand": L_WRIST, "rightHand": R_WRIST}

# hand indices
WRIST, THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP = 0, 4, 8, 12, 16, 20
FINGERTIPS = (THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP)


def ensure_model(path: Path = MODEL_PATH, url: str = MODEL_URL) -> Path:
    """Download the holistic model once (free, public Google bucket)."""
    if path.exists() and path.stat().st_size > 0:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    print(f"downloading {url} -> {path}")
    urllib.request.urlretrieve(url, tmp)
    tmp.replace(path)
    return path


def rnd(v: float, nd: int = DECIMALS) -> float | None:
    """Round to `nd` decimals; non-finite becomes None (JSON has no NaN)."""
    if v is None:
        return None
    v = float(v)
    if not math.isfinite(v):
        return None
    r = round(v, nd)
    return 0.0 if r == 0 else r  # avoid "-0.0"


def round_points(points: Any, nd: int = DECIMALS) -> list | None:
    """Round a list of points (list of lists). None stays None."""
    if points is None:
        return None
    return [[rnd(c, nd) for c in p] for p in points]


def mirror_label(part: str) -> str:
    """Swap left/right in a part key (leftHand <-> rightHand, etc.)."""
    if part.startswith("left"):
        return "right" + part[4:]
    if part.startswith("right"):
        return "left" + part[5:]
    return part


def motion_id_from_gloss(gloss: str | None) -> str | None:
    """Canonical catalog ID from a gloss: uppercase, spaces/hyphens -> underscore, only A-Z 0-9 _.

    "thank you" -> "THANK_YOU", "a lot" -> "A_LOT". None/empty -> None (sentence clips).
    """
    if not gloss:
        return None
    s = re.sub(r"[\s\-]+", "_", gloss.strip().upper())
    s = re.sub(r"[^A-Z0-9_]", "", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or None


def load_json(path: str | Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(obj: dict, path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
    tmp.replace(path)


def rel_to_repo(p: str | Path) -> str:
    """Repo-relative POSIX path if inside the repo, else the absolute POSIX path."""
    p = Path(p).resolve()
    try:
        return p.relative_to(REPO).as_posix()
    except ValueError:
        return p.as_posix()


# ---------------------------------------------------------------- mirroring data

# MediaPipe pose left/right pairs (0 = nose has no partner).
POSE_LR_PAIRS = [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 18),
                 (19, 20), (21, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32)]
POSE_MIRROR_INDEX = list(range(33))
for _a, _b in POSE_LR_PAIRS:
    POSE_MIRROR_INDEX[_a], POSE_MIRROR_INDEX[_b] = _b, _a


def _flip_image_pts(pts):
    return None if pts is None else [[rnd(1.0 - p[0]), *(rnd(c) for c in p[1:])] for p in pts]


def _flip_world_pts(pts):
    return None if pts is None else [[rnd(-p[0]), *(rnd(c) for c in p[1:])] for p in pts]


def _swap_bs_name(name: str) -> str:
    if name.endswith("Left"):
        return name[:-4] + "Right"
    if name.endswith("Right"):
        return name[:-5] + "Left"
    return name


def mirror_frame(frame: dict) -> dict:
    """Mirror one frame left-right WITHOUT re-tracking.

    Image x -> 1 - x, world x -> -x, left/right labels swapped (hands, pose landmark pairs,
    blendshape names), so labels stay the subject's own hands in the mirrored picture.
    The face mesh has no simple index symmetry table here, so `face` is set to null:
    re-track with `extract.py --mirror` when the face is needed.
    """
    out = {"i": frame["i"], "t": frame["t"]}
    pose = frame.get("pose")
    out["pose"] = None if pose is None else _flip_image_pts([pose[j] for j in POSE_MIRROR_INDEX])
    pw = frame.get("poseWorld")
    out["poseWorld"] = None if pw is None else _flip_world_pts([pw[j] for j in POSE_MIRROR_INDEX])
    out["face"] = None
    bs = frame.get("faceBlendshapes")
    out["faceBlendshapes"] = None if bs is None else {_swap_bs_name(k): v for k, v in bs.items()}
    for part in ("leftHand", "rightHand"):
        out[mirror_label(part)] = _flip_image_pts(frame.get(part))
    for part in ("leftHandWorld", "rightHandWorld"):
        out[mirror_label(part)] = _flip_world_pts(frame.get(part))
    return out
