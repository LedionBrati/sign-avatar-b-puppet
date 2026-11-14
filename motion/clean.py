"""Clean a `.raw.json` into a `.clean.json` (FORMAT.md v1).

    uv run python clean.py ../out/motion/judy.raw.json --out ../out/motion/judy.clean.json
    uv run python clean.py sign.raw.json --out sign.clean.json --trim-rest     # isolated dictionary signs

Steps, in order:
1. `--trim-rest` (optional): drop leading/trailing frames where BOTH wrists are at rest
   (low: below the rest line near the waist, or not visible) AND slow. The rise out of rest is kept.
2. Gap fill: an interior gap of <= MAX_GAP frames in a part (hand, face, pose, ...) is linearly
   interpolated between the frames on either side and listed in `cleanup.filled_frames`.
   Longer gaps, and gaps touching the start/end, stay null.
3. One Euro filter on every x/y/z coordinate of every part, restarted after every null gap so
   it never smooths across a tracking loss. Parameters are in ONE_EURO_PARAMS below and are
   written to `cleanup.params`. They are tuned to follow fast handshape changes: hands use a
   high `beta`, so the cut-off frequency rises quickly when a fingertip moves.
4. `dominant_hand` from pose wrist motion (see detect_dominant_hand).

The raw file is never changed; re-run this to try other settings.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import sys

import numpy as np

from common import (
    ALL_PARTS,
    L_HIP,
    L_SHOULDER,
    L_WRIST,
    R_HIP,
    R_SHOULDER,
    R_WRIST,
    load_json,
    rnd,
    round_points,
    save_json,
)

MAX_GAP = 4  # frames; at 24-25 fps that is ~0.16 s

# One Euro parameters per part. min_cutoff in Hz, beta in 1/(units per second), d_cutoff in Hz.
# Image coords are 0..1 of the frame, world coords are metres; both move ~0.5-3 units/s in signing.
# Hands were picked from a sweep on judy + travis (experiments/2026-11-14-motion-extraction.md):
# at 24 fps real fast handshape changes and tracker noise overlap in frequency, so every bit of
# smoothing also shaves fast transitions. On the 4 How2Sign clips these settings keep a median ~89%
# (81-112%) of the 95th-percentile handshape change (fingertips relative to the wrist, per hand) while
# cutting 2nd-difference fingertip jitter by ~20-28%. Stronger smoothing cut transitions much more.
# At rest the cut-off is 1 Hz (held handshapes are steadied); a one-frame fingertip step of 0.1
# (half a hand-length) is followed ~87% on the first frame and ~98% on the second.
ONE_EURO_PARAMS = {
    "pose": {"min_cutoff": 1.0, "beta": 10.0, "d_cutoff": 2.0},
    "poseWorld": {"min_cutoff": 1.0, "beta": 10.0, "d_cutoff": 2.0},
    "face": {"min_cutoff": 1.0, "beta": 5.0, "d_cutoff": 2.0},
    "leftHand": {"min_cutoff": 1.0, "beta": 30.0, "d_cutoff": 2.0},
    "rightHand": {"min_cutoff": 1.0, "beta": 30.0, "d_cutoff": 2.0},
    "leftHandWorld": {"min_cutoff": 1.0, "beta": 30.0, "d_cutoff": 2.0},
    "rightHandWorld": {"min_cutoff": 1.0, "beta": 30.0, "d_cutoff": 2.0},
}

# trim-rest thresholds
REST_LINE = 0.80  # wrist counts as "low" below shoulder_y + REST_LINE * (hip_y - shoulder_y)
REST_SPEED = 0.02  # "slow": wrist moves < this many shoulder-widths per frame
REST_VIS = 0.5  # pose wrist visibility below this = not visible (out of frame) = at rest
TRIM_PAD = 2  # frames of rest kept on each side of the active span
BOTTOM_EDGE = 0.92  # pose wrist below this y = hand at the bottom edge / out of the picture = resting.
                    # Needed because many clips cut off at the waist, so the hip estimate (and the
                    # rest line derived from it) lands below the frame.


# ---------------------------------------------------------------- One Euro filter

def _alpha(cutoff: float, dt: float) -> float:
    tau = 1.0 / (2.0 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


def one_euro(x: np.ndarray, fps: float, min_cutoff: float, beta: float, d_cutoff: float = 1.0) -> np.ndarray:
    """One Euro filter (Casiez et al. 2012) along axis 0 of `x` (frames x ...), elementwise.

    `x` must have no NaNs; split at gaps before calling.
    """
    x = np.asarray(x, dtype=float)
    if len(x) == 0:
        return x.copy()
    dt = 1.0 / fps
    out = np.empty_like(x)
    out[0] = x[0]
    dx_hat = np.zeros_like(x[0])
    a_d = _alpha(d_cutoff, dt)
    for t in range(1, len(x)):
        dx = (x[t] - out[t - 1]) / dt
        dx_hat = a_d * dx + (1 - a_d) * dx_hat
        cutoff = min_cutoff + beta * np.abs(dx_hat)
        tau = 1.0 / (2.0 * math.pi * cutoff)
        a = 1.0 / (1.0 + tau / dt)
        out[t] = a * x[t] + (1 - a) * out[t - 1]
    return out


def present_runs(mask) -> list[tuple[int, int]]:
    """[(start, end_exclusive)] of consecutive True values."""
    runs, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        elif not m and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def smooth_part(frames: list[dict], part: str, fps: float, params: dict) -> None:
    """In place: One Euro on x,y,z of `part`, per present run. A 4th channel (pose visibility) is kept."""
    mask = [f.get(part) is not None for f in frames]
    for s, e in present_runs(mask):
        arr = np.array([frames[i][part] for i in range(s, e)], dtype=float)  # (T, N, C)
        xyz = one_euro(arr[..., :3], fps, **params)
        arr[..., :3] = xyz
        for k, i in enumerate(range(s, e)):
            frames[i][part] = round_points(arr[k].tolist())


# ---------------------------------------------------------------- gap filling

def fill_gaps(frames: list[dict], part: str, max_gap: int = MAX_GAP) -> list[int]:
    """In place: linear interpolation of interior gaps <= max_gap. Returns filled frame indices."""
    n = len(frames)
    mask = [f.get(part) is not None for f in frames]
    filled = []
    i = 0
    while i < n:
        if mask[i]:
            i += 1
            continue
        j = i
        while j < n and not mask[j]:
            j += 1
        gap = j - i
        if i > 0 and j < n and gap <= max_gap:
            a = np.array(frames[i - 1][part], dtype=float)
            b = np.array(frames[j][part], dtype=float)
            if a.shape == b.shape:
                for k in range(gap):
                    w = (k + 1) / (gap + 1)
                    frames[i + k][part] = round_points(((1 - w) * a + w * b).tolist())
                    filled.append(i + k)
        i = j
    return filled


def fill_blendshapes(frames: list[dict], face_filled: list[int]) -> None:
    """Give gap-filled face frames interpolated blendshapes too (nearest present neighbours)."""
    present = [i for i, f in enumerate(frames) if f.get("faceBlendshapes")]
    for i in face_filled:
        if frames[i].get("faceBlendshapes"):
            continue
        before = [p for p in present if p < i]
        after = [p for p in present if p > i]
        if not before or not after:
            continue
        a, b = before[-1], after[0]
        w = (i - a) / (b - a)
        A, B = frames[a]["faceBlendshapes"], frames[b]["faceBlendshapes"]
        frames[i]["faceBlendshapes"] = {k: rnd((1 - w) * A[k] + w * B.get(k, A[k])) for k in A}


# ---------------------------------------------------------------- body geometry helpers

def _pose_arr(frames: list[dict]) -> np.ndarray:
    """(T, 33, 4) pose array with NaN for missing frames."""
    out = np.full((len(frames), 33, 4), np.nan)
    for i, f in enumerate(frames):
        if f.get("pose") is not None:
            out[i] = np.array(f["pose"], dtype=float)
    return out


def _body_refs(pose: np.ndarray) -> tuple[float, float, float]:
    """Median shoulder y, hip y and shoulder width over the clip (image coords)."""
    sh_y = np.nanmedian((pose[:, L_SHOULDER, 1] + pose[:, R_SHOULDER, 1]) / 2)
    hip_y = np.nanmedian((pose[:, L_HIP, 1] + pose[:, R_HIP, 1]) / 2)
    sw = np.nanmedian(np.hypot(pose[:, L_SHOULDER, 0] - pose[:, R_SHOULDER, 0],
                               pose[:, L_SHOULDER, 1] - pose[:, R_SHOULDER, 1]))
    if not np.isfinite(sw) or sw <= 1e-3:
        sw = 0.25
    if not np.isfinite(sh_y):
        sh_y = 0.4
    if not np.isfinite(hip_y) or hip_y <= sh_y:
        hip_y = sh_y + 1.5 * sw  # hips usually ~1.5 shoulder widths below the shoulders
    return float(sh_y), float(hip_y), float(sw)


def _wrist_speed(pose: np.ndarray, idx: int, sw: float) -> np.ndarray:
    """Per-frame wrist speed in shoulder widths per frame (central difference, NaN-safe -> 0)."""
    xy = pose[:, idx, :2]
    T = len(xy)
    sp = np.zeros(T)
    for t in range(T):
        a, b = max(t - 1, 0), min(t + 1, T - 1)
        if b == a:
            continue
        d = (xy[b] - xy[a]) / (b - a)
        v = float(np.hypot(*d)) / sw
        sp[t] = v if np.isfinite(v) else 0.0
    return sp


# ---------------------------------------------------------------- dominant hand

DOM_RIGHT_RATIO = 1.25  # right wins at this score ratio
DOM_LEFT_RATIO = 1.75  # left needs a clearer margin: most signers are right-dominant, and a false
                      # "left" makes the batch mirror a sign that did not need it
DOM_PRESENCE_RATIO = 0.25  # one hand tracked in < 25% as many frames as the other -> the other is dominant
OUT_OF_FRAME_Y = BOTTOM_EDGE  # pose wrists below this are guesses at the edge; their jitter is ignored


def detect_dominant_hand(motion: dict) -> dict:
    """Which of the SUBJECT's hands does the signing. Returns {"hand", "scores", "height", "presence", "rule"}.

    1. presence: if one hand's landmarks are found in >= 30% of frames and the other in fewer than
       DOM_PRESENCE_RATIO as many, the tracked hand is dominant (one-handed sign, other hand out of frame).
    2. motion score = path length of the pose wrist (15 left / 16 right, in shoulder widths; movement
       above the rest line counts fully, near rest 25%; only visible, in-picture wrists) + path length of
       the hand landmarks' centre while tracked. Right wins at ratio >= 1.25, left at >= 1.75.
    3. otherwise the hand held clearly higher on average (> 0.15 torso heights).
    4. otherwise None: a symmetric two-handed sign, or no movement.
    """
    frames = motion["frames"]
    pose = _pose_arr(frames)
    res = {"hand": None, "scores": {}, "height": {}, "presence": {}, "rule": None}
    T = len(frames)
    if T < 2 or np.all(np.isnan(pose[:, 0, 0])):
        return res
    sh_y, hip_y, sw = _body_refs(pose)
    rest_y = sh_y + REST_LINE * (hip_y - sh_y)
    for hand, idx, part in (("left", L_WRIST, "leftHand"), ("right", R_WRIST, "rightHand")):
        xy = pose[:, idx, :2]
        vis = pose[:, idx, 3]
        inpic = (vis >= REST_VIS) & (xy[:, 1] < OUT_OF_FRAME_Y)
        step = np.hypot(*(xy[1:] - xy[:-1]).T) / sw
        ok = inpic[1:] & inpic[:-1] & np.isfinite(step)
        w = np.where(xy[1:, 1] < rest_y, 1.0, 0.25)
        score = float(np.sum(np.where(ok, step * w, 0.0)))
        cen = np.full((T, 2), np.nan)
        for i, f in enumerate(frames):
            if f.get(part) is not None:
                cen[i] = np.mean(np.array(f[part], dtype=float)[:, :2], axis=0)
        hstep = np.hypot(*(cen[1:] - cen[:-1]).T) / sw
        score += float(np.nansum(np.where(np.isfinite(hstep), hstep * w, 0.0)))
        h = (hip_y - xy[:, 1]) / max(hip_y - sh_y, 1e-3)
        h = np.where(inpic, h, -0.5)  # not in the picture = low
        res["scores"][hand] = round(score, 3)
        res["height"][hand] = round(float(np.nanmean(h)), 3)
        res["presence"][hand] = round(float(np.mean(~np.isnan(cen[:, 0]))), 3)
    pl, pr = res["presence"]["left"], res["presence"]["right"]
    if pr >= 0.3 and pl < DOM_PRESENCE_RATIO * pr:
        res.update(hand="right", rule="presence")
        return res
    if pl >= 0.3 and pr < DOM_PRESENCE_RATIO * pl:
        res.update(hand="left", rule="presence")
        return res
    L, R = res["scores"]["left"], res["scores"]["right"]
    if max(L, R) < 0.5:  # almost no movement at all
        return res
    if R >= DOM_RIGHT_RATIO * L:
        res.update(hand="right", rule="motion")
    elif L >= DOM_LEFT_RATIO * R:
        res.update(hand="left", rule="motion")
    else:
        hl, hr = res["height"]["left"], res["height"]["right"]
        if hr - hl > 0.15:
            res.update(hand="right", rule="height")
        elif hl - hr > 0.15:
            res.update(hand="left", rule="height")
    return res


# ---------------------------------------------------------------- trim to rest

def rest_mask(motion: dict) -> np.ndarray:
    """True where BOTH wrists are at rest: (low or not visible) and slow."""
    frames = motion["frames"]
    pose = _pose_arr(frames)
    T = len(frames)
    if T == 0 or np.all(np.isnan(pose[:, 0, 0])):
        return np.ones(T, dtype=bool)
    sh_y, hip_y, sw = _body_refs(pose)
    rest_y = sh_y + REST_LINE * (hip_y - sh_y)
    rest = np.ones(T, dtype=bool)
    for idx in (L_WRIST, R_WRIST):
        y = pose[:, idx, 1]
        vis = pose[:, idx, 3]
        invisible = ~(vis >= REST_VIS) | (y > BOTTOM_EDGE)  # NaN-safe; below the edge = out of picture, jitter ignored
        low = invisible | (y > rest_y)
        slow = _wrist_speed(pose, idx, sw) < REST_SPEED
        rest &= low & (slow | invisible)
    no_pose = np.isnan(pose[:, 0, 0])
    rest |= no_pose
    return rest


def trim_rest_range(motion: dict, pad: int = TRIM_PAD) -> tuple[int, int]:
    """(first, last) frame indices to keep, both inclusive. Whole clip if never active."""
    rest = rest_mask(motion)
    T = len(rest)
    active = np.where(~rest)[0]
    if len(active) == 0:
        return 0, T - 1
    return max(int(active[0]) - pad, 0), min(int(active[-1]) + pad, T - 1)


# ---------------------------------------------------------------- hand world anchoring

HAND_WORLD_WRIST = {"leftHandWorld": L_WRIST, "rightHandWorld": R_WRIST}


def hand_world_is_anchored(frames: list[dict], tol: float = 0.005) -> bool:
    """True if hand world wrists sit on the poseWorld wrists (what MediaPipe holistic 1.2.3 outputs:
    hand world points share the pose world frame, origin between the hips)."""
    d = []
    for f in frames:
        for part, pi in HAND_WORLD_WRIST.items():
            if f.get(part) is not None and f.get("poseWorld") is not None:
                d.append(np.linalg.norm(np.array(f[part][0]) - np.array(f["poseWorld"][pi][:3])))
    return bool(d) and float(np.median(d)) < tol


def anchor_hand_world(frames: list[dict]) -> bool:
    """In place: after smoothing, shift each hand world skeleton so its wrist sits exactly on the
    (smoothed) poseWorld wrist again. Hands and pose are smoothed with different settings, so
    without this the two would drift apart by a few millimetres."""
    for f in frames:
        for part, pi in HAND_WORLD_WRIST.items():
            if f.get(part) is not None and f.get("poseWorld") is not None:
                h = np.array(f[part], dtype=float)
                h += np.array(f["poseWorld"][pi][:3], dtype=float) - h[0]
                f[part] = round_points(h.tolist())
    return True


# ---------------------------------------------------------------- whole pipeline

def clean_motion(raw: dict, trim_rest: bool = False, max_gap: int = MAX_GAP,
                 params: dict | None = None) -> dict:
    params = params or ONE_EURO_PARAMS
    out = copy.deepcopy(raw)
    fps = float(raw["fps"])
    n = len(raw["frames"])
    first, last = (trim_rest_range(raw) if trim_rest and n else (0, max(n - 1, 0)))
    frames = out["frames"][first:last + 1] if n else []
    for k, f in enumerate(frames):
        f["i"] = k
        f["t"] = rnd(k / fps)

    filled = {}
    for part in ALL_PARTS:
        idx = fill_gaps(frames, part, max_gap)
        if idx:
            filled[part] = idx
    if "face" in filled:
        fill_blendshapes(frames, filled["face"])

    for part in ALL_PARTS:
        if part in params:
            smooth_part(frames, part, fps, params[part])
    anchored = anchor_hand_world(frames) if hand_world_is_anchored(raw["frames"]) else False

    out["frames"] = frames
    start0 = raw["source"].get("start_s") or 0.0
    out["source"]["start_s"] = rnd(start0 + first / fps)
    out["source"]["end_s"] = rnd(start0 + (last + 1) / fps) if n else raw["source"].get("end_s")
    out["cleaned"] = True
    out["cleanup"] = {
        "smoothing": "one-euro",
        "params": params,
        "trim": [first, last],
        "filled_frames": filled,
        "max_gap": max_gap,
        "trim_rest": bool(trim_rest),
        "hand_world_anchor": "poseWorld wrist" if anchored else None,
    }
    out["dominant_hand"] = detect_dominant_hand(out)["hand"]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("raw")
    ap.add_argument("--out", required=True)
    ap.add_argument("--trim-rest", action="store_true")
    ap.add_argument("--max-gap", type=int, default=MAX_GAP)
    a = ap.parse_args(argv)
    raw = load_json(a.raw)
    if raw.get("cleaned"):
        print("warning: input is already cleaned; cleaning from the .raw.json is recommended", file=sys.stderr)
    clean = clean_motion(raw, trim_rest=a.trim_rest, max_gap=a.max_gap)
    save_json(clean, a.out)
    c = clean["cleanup"]
    print(json.dumps({
        "out": a.out, "frames_in": len(raw["frames"]), "frames_out": len(clean["frames"]),
        "trim": c["trim"], "filled": {k: len(v) for k, v in c["filled_frames"].items()},
        "dominant_hand": clean["dominant_hand"],
    }))


if __name__ == "__main__":
    sys.exit(main())
