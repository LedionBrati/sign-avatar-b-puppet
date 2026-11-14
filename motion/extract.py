"""Extract MediaPipe holistic landmarks from a video into a FORMAT.md v1 `.raw.json`.

    uv run python extract.py ../references/how2sign/judy.mp4 --out ../out/motion/judy.raw.json \
        --dataset How2Sign --license "CC BY-NC 4.0" --signer 3

Every frame is tracked (HolisticLandmarker, VIDEO running mode, timestamps from the
video fps). Nothing is smoothed or filled: a part that is not detected is `null`.

Left/right convention (checked on the How2Sign clips, see experiments/2026-11-14-motion-extraction.md):
MediaPipe holistic's `left_hand_landmarks` is the SUBJECT's left hand. In a normal
(non-mirrored) front camera video the subject's left hand appears on the IMAGE RIGHT
(larger x), and its wrist sits on pose landmark 15 (left wrist). That is exactly
FORMAT.md's convention, so labels are written as-is.

`--mirror` flips every frame left-right BEFORE tracking. MediaPipe then labels the hands of
the person seen in the flipped video, so `leftHand` is the subject's left hand *after*
mirroring (= the original signer's right hand). `mirrored` is set to true.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions, vision

from common import (
    FORMAT_VERSION,
    MODEL_LABEL,
    ensure_model,
    motion_id_from_gloss,
    rel_to_repo,
    rnd,
    round_points,
    save_json,
)


def _pts(landmarks, with_visibility: bool = False):
    """MediaPipe landmark list -> list of [x, y, z(, vis)] rounded, or None if empty."""
    if not landmarks:
        return None
    if with_visibility:
        return round_points([[l.x, l.y, l.z, l.visibility if l.visibility is not None else 0.0] for l in landmarks])
    return round_points([[l.x, l.y, l.z] for l in landmarks])


def _blendshapes(cats):
    """List of Category -> {name: score}. Drops MediaPipe's extra `_neutral` (FORMAT wants the 52 ARKit names)."""
    if not cats:
        return None
    return {c.category_name: rnd(c.score) for c in cats if c.category_name and not c.category_name.startswith("_")}


def result_to_frame(i: int, t: float, r) -> dict:
    return {
        "i": i,
        "t": rnd(t),
        "pose": _pts(r.pose_landmarks, with_visibility=True),
        "poseWorld": _pts(r.pose_world_landmarks),
        "face": _pts(r.face_landmarks),
        "faceBlendshapes": _blendshapes(r.face_blendshapes),
        "leftHand": _pts(r.left_hand_landmarks),
        "leftHandWorld": _pts(r.left_hand_world_landmarks),
        "rightHand": _pts(r.right_hand_landmarks),
        "rightHandWorld": _pts(r.right_hand_world_landmarks),
    }


def make_landmarker(model_path: Path):
    opts = vision.HolisticLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.VIDEO,
        output_face_blendshapes=True,
    )
    return vision.HolisticLandmarker.create_from_options(opts)


def extract_video(
    video: str | Path,
    *,
    name: str | None = None,
    mirror: bool = False,
    dataset: str | None = None,
    license: str | None = None,
    signer: str | None = None,
    gloss: str | None = None,
    motion_id: str | None = None,
    source_file: str | None = None,
    model_path: Path | None = None,
) -> tuple[dict, dict]:
    """Track every frame of `video`. Returns (motion dict, stats dict)."""
    video = Path(video)
    model_path = model_path or ensure_model()
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    if fps <= 0 or fps > 240:
        raise RuntimeError(f"{video}: bad fps {fps}")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    frames = []
    t0 = time.perf_counter()
    with make_landmarker(model_path) as lm:
        i = 0
        last_ts = -1
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            if mirror:
                bgr = cv2.flip(bgr, 1)
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            ts_ms = int(round(i * 1000.0 / fps))
            if ts_ms <= last_ts:  # VIDEO mode needs strictly increasing timestamps
                ts_ms = last_ts + 1
            last_ts = ts_ms
            r = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts_ms)
            frames.append(result_to_frame(i, i / fps, r))
            i += 1
    cap.release()
    secs = time.perf_counter() - t0

    fps_out = round(fps, 3)
    if abs(fps_out - round(fps_out)) < 1e-3:
        fps_out = int(round(fps_out))

    from clean import detect_dominant_hand  # local import: clean imports nothing from here

    motion = {
        "version": FORMAT_VERSION,
        "name": name or video.stem,
        "motion_id": motion_id if motion_id is not None else motion_id_from_gloss(gloss),
        "gloss": gloss,
        "source": {
            "file": source_file or rel_to_repo(video),
            "dataset": dataset,
            "license": license,
            "signer": None if signer is None else str(signer),
            "start_s": 0.0,
            "end_s": rnd(len(frames) / fps),
        },
        "fps": fps_out,
        "width": width,
        "height": height,
        "dominant_hand": None,
        "mirrored": bool(mirror),
        "extractor": {"name": "mediapipe-holistic-landmarker", "version": mp.__version__, "model": MODEL_LABEL},
        "cleaned": False,
        "cleanup": None,
        "frames": frames,
    }
    motion["dominant_hand"] = detect_dominant_hand(motion)["hand"]
    n = len(frames)
    stats = {
        "video": str(video),
        "frames": n,
        "seconds": round(secs, 2),
        "fps_processed": round(n / secs, 2) if secs > 0 else None,
        "mirrored": bool(mirror),
        "pose_pct": round(100 * sum(f["pose"] is not None for f in frames) / max(n, 1), 1),
        "left_pct": round(100 * sum(f["leftHand"] is not None for f in frames) / max(n, 1), 1),
        "right_pct": round(100 * sum(f["rightHand"] is not None for f in frames) / max(n, 1), 1),
        "face_pct": round(100 * sum(f["face"] is not None for f in frames) / max(n, 1), 1),
        "dominant_hand": motion["dominant_hand"],
    }
    return motion, stats


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--out", required=True, help="output PATH.raw.json")
    ap.add_argument("--name", help="motion name (default: video file stem)")
    ap.add_argument("--dataset")
    ap.add_argument("--license")
    ap.add_argument("--signer")
    ap.add_argument("--gloss")
    ap.add_argument("--motion-id", help="catalog ID (default: derived from --gloss, e.g. 'thank you' -> THANK_YOU; null without a gloss)")
    ap.add_argument("--source-file", help="value for source.file (default: repo-relative video path)")
    ap.add_argument("--mirror", action="store_true", help="flip frames left-right before tracking")
    a = ap.parse_args(argv)
    motion, stats = extract_video(
        a.video, name=a.name, mirror=a.mirror, dataset=a.dataset, license=a.license,
        signer=a.signer, gloss=a.gloss, motion_id=a.motion_id, source_file=a.source_file,
    )
    save_json(motion, a.out)
    stats["out"] = str(a.out)
    print(json.dumps(stats))


if __name__ == "__main__":
    sys.exit(main())
