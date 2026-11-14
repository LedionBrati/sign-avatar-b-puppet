"""Synthetic motion data for tests (no video, no MediaPipe)."""
import numpy as np


def pose_points(lw=(0.62, 0.95), rw=(0.38, 0.95), vis=0.99):
    """33 pose points: shoulders y=0.4, hips y=0.8, given wrist positions (image coords)."""
    p = [[0.5, 0.25, 0.0, vis] for _ in range(33)]
    p[11] = [0.6, 0.4, 0.0, vis]  # left shoulder (image right)
    p[12] = [0.4, 0.4, 0.0, vis]
    p[23] = [0.57, 0.8, 0.0, vis]
    p[24] = [0.43, 0.8, 0.0, vis]
    p[15] = [lw[0], lw[1], 0.0, vis]
    p[16] = [rw[0], rw[1], 0.0, vis]
    p[19] = [lw[0], lw[1] - 0.03, 0.0, vis]
    p[20] = [rw[0], rw[1] - 0.03, 0.0, vis]
    return p


def hand_points(cx, cy, s=0.05):
    return [[cx + s * np.cos(k), cy + s * np.sin(k), 0.0] for k in range(21)]


def frame(i, fps=24, lw=(0.62, 0.95), rw=(0.38, 0.95), left=True, right=True):
    return {
        "i": i, "t": i / fps,
        "pose": pose_points(lw, rw),
        "poseWorld": [[0.0, 0.0, 0.0] for _ in range(33)],
        "face": None, "faceBlendshapes": None,
        "leftHand": hand_points(*lw) if left else None,
        "leftHandWorld": None,
        "rightHand": hand_points(*rw) if right else None,
        "rightHandWorld": None,
    }


def motion(frames, fps=24):
    return {
        "version": 1, "name": "synth", "gloss": None,
        "source": {"file": "x.mp4", "dataset": None, "license": None, "signer": None,
                   "start_s": 0.0, "end_s": len(frames) / fps},
        "fps": fps, "width": 540, "height": 720, "dominant_hand": None, "mirrored": False,
        "extractor": {"name": "test", "version": "0", "model": "none"},
        "cleaned": False, "cleanup": None, "frames": frames,
    }


def signing_clip(hand="right", rest=10, sign=20, fps=24):
    """`rest` frames at rest, `sign` frames with one wrist raised and circling, `rest` frames at rest."""
    frames = []
    T = 2 * rest + sign
    for i in range(T):
        lw, rw = (0.62, 0.95), (0.38, 0.95)
        if rest <= i < rest + sign:
            a = 2 * np.pi * (i - rest) / 8
            pos = (0.5 + 0.08 * np.cos(a), 0.45 + 0.08 * np.sin(a))
            if hand == "right":
                rw = pos
            else:
                lw = pos
        frames.append(frame(i, fps, lw, rw))
    return motion(frames, fps)
