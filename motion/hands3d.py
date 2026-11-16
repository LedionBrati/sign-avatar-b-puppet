"""Anatomical 3D hands for a motion file: `.raw.json` + `.clean.json` -> `.v2.json` (FORMAT.md v2).

    uv run python hands3d.py ../out/motion/wlasl/hello-aaf4c6.raw.json \
        --clean ../out/motion/wlasl/hello-aaf4c6.clean.json --video <signs>/videos/hello-aaf4c6.mp4 \
        --out ../out/motion/hands3d/hello-aaf4c6.v2.json
    # add --keypoints X.wilor.json to use GPU hand-model joints (hands_gpu.py) instead of MediaPipe's

Per hand, per frame of the clean file:
1. Observation: 21 points from, in order of preference, the GPU hand model (`--keypoints`), the
   Holistic hand (raw, unsmoothed), or a re-detection on a zoomed crop (`--video`, redetect.py)
   for frames Holistic missed or got anatomically impossible.
2. IK fit of the articulated skeleton (hand_model.py): global wrist rotation + 22 joint angles,
   each inside its joint limit, bone lengths fixed. Fitted per run of frames; a second pass pulls
   each frame toward its neighbours' median angles, which steadies single blurred frames.
3. Gaps of up to MAX_FILL frames are filled by interpolating joint ANGLES (and slerping the wrist),
   so a filled hand is still a valid hand. Longer gaps stay null.
4. One Euro smoothing of the joint angles and wrist rotation. Angles are averaged with positive
   weights, so they stay inside the limits.
5. Output: the clean file (all v1 fields) + `hands3d` per frame + `hands3d_meta`. With
   `--v1-hands fitted` (default), left/rightHandWorld are replaced by the fitted skeleton so v1
   readers (the puppet) get the anatomical fingers too; the originals stay in the raw file.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import sys
import time

import hand_model as hm  # first: it pins BLAS to one thread before numpy loads
import numpy as np
from scipy.spatial.transform import Rotation, Slerp

from clean import one_euro, present_runs
from common import load_json, rnd, round_points, save_json

MAX_FILL = 6  # frames (~0.24 s at 25 fps) of missing hand filled in joint-angle space
MAX_FIT_MM = 30.0  # a frame whose best anatomical fit is this far from the tracker is dropped (then
                   # filled from its neighbours): e.g. a half-out-of-frame hand at the bottom edge
# One Euro on angles (radians). Picked from a sweep on HELLO, NO, WHERE, THANK_YOU (experiments/
# 2026-11-16-anatomical-hands.md): 1.0/1.5 halved angle jitter more but kept only 50-67% of the fastest
# angle changes; 2.0/5.0 cuts jitter ~40% and keeps 62-86%. At rest 2 Hz; 5 rad/s lifts it to ~27 Hz.
ANGLE_FILTER = {"min_cutoff": 2.0, "beta": 5.0, "d_cutoff": 2.0}
ROT_FILTER = {"min_cutoff": 1.5, "beta": 3.0, "d_cutoff": 2.0}
FIT_MM_FREE, FIT_MM_SCALE = 10.0, 15.0  # conf = source conf * exp(-max(0, fit_mm - FREE) / SCALE)
SOURCE_CONF = {"wilor": 1.0, "holistic": 0.9, "redetect": 0.7, "filled": 0.35}
SIDES = ("left", "right")
POSE_WRIST = {"left": 15, "right": 16}
MIRROR = np.diag([-1.0, 1.0, 1.0])


def _obs_points(frame: dict, side: str, W: int, H: int):
    """Holistic hand points in camera axes (metres-ish world if present, else image px)."""
    w = frame.get(f"{side}HandWorld")
    if w is not None:
        return np.array(w, dtype=float)
    im = frame.get(f"{side}Hand")
    if im is not None:
        return np.array(im, dtype=float) * [W, H, W]
    return None


def _to_right(pts, side):
    """Left hands are fitted as mirrored right hands."""
    return pts @ MIRROR if side == "left" else pts


def collect_observations(raw: dict, first: int, last: int, video: str | None = None,
                         keypoints: dict | None = None, redetect: bool = True) -> dict:
    """{side: [obs | None] * T} with obs = {"pts": 21x3 camera axes, "src": str, "conf": float,
    "image": 21x3 | None (image coords 0..1 when the source had them)}."""
    W, H = raw["width"], raw["height"]
    rf = raw["frames"]
    T = last - first + 1
    obs = {s: [None] * T for s in SIDES}
    todo = []
    for t in range(T):
        i = first + t
        f = rf[i]
        for s in SIDES:
            kp = None
            if keypoints is not None:
                kp = (keypoints.get("frames", {}).get(str(i)) or {}).get(s)
            if kp is not None and kp.get("joints") is not None:
                obs[s][t] = {"pts": np.array(kp["joints"], float), "src": "wilor",
                             "conf": float(kp.get("conf", 1.0)) * SOURCE_CONF["wilor"],
                             "image": kp.get("image")}
                continue
            p = _obs_points(f, s, W, H)
            if p is not None:
                obs[s][t] = {"pts": p, "src": "holistic", "conf": SOURCE_CONF["holistic"],
                             "image": f.get(f"{s}Hand")}
                if hm.impossible_joints(_to_right(p, s)):
                    todo.append((i, s))  # try a second opinion
            elif f.get("pose") is not None and f["pose"][POSE_WRIST[s]][3] >= 0.3 \
                    and f["pose"][POSE_WRIST[s]][1] < 0.97:
                todo.append((i, s))
    stats = {"redetect_tried": len(todo), "redetect_found": 0, "redetect_replaced_impossible": 0}
    if redetect and video and todo:
        from redetect import redetect_hands

        found = redetect_hands(video, raw, todo)
        for (i, s), r in found.items():
            t = i - first
            cand = {"pts": np.array(r["world"], float), "src": "redetect",
                    "conf": SOURCE_CONF["redetect"] * r["score"], "image": r["image"]}
            cur = obs[s][t]
            if cur is None:
                obs[s][t] = cand
                stats["redetect_found"] += 1
            elif len(hm.impossible_joints(_to_right(cand["pts"], s))) < \
                    len(hm.impossible_joints(_to_right(cur["pts"], s))):
                obs[s][t] = cand
                stats["redetect_replaced_impossible"] += 1
    return obs, stats


def fit_sequence(obs_list: list, side: str):
    """IK per continuous run of observed frames (batched; the temporal prior never crosses a gap).
    Returns lists (R0 | None, theta | None, fit_mm | None), right-hand space."""
    T = len(obs_list)
    R0s, thetas, fits = [None] * T, [None] * T, [None] * T
    for s, e in present_runs([o is not None for o in obs_list]):
        P = np.stack([_to_right(obs_list[t]["pts"], side) for t in range(s, e)])
        R0, th, mm = hm.fit_hands_batch(P)
        for k, t in enumerate(range(s, e)):
            R0s[t], thetas[t], fits[t] = R0[k], th[k], float(mm[k])
    return R0s, thetas, fits


def fill_gaps(R0s, thetas, srcs, max_fill: int = MAX_FILL):
    """In place: interior gaps <= max_fill interpolated in angle space; returns filled indices."""
    T = len(thetas)
    mask = [th is not None for th in thetas]
    filled = []
    t = 0
    while t < T:
        if mask[t]:
            t += 1
            continue
        j = t
        while j < T and not mask[j]:
            j += 1
        if t > 0 and j < T and (j - t) <= max_fill:
            a, b = t - 1, j
            sl = Slerp([0.0, 1.0], Rotation.from_matrix(np.stack([R0s[a], R0s[b]])))
            for k in range(t, j):
                w = (k - a) / (b - a)
                thetas[k] = (1 - w) * thetas[a] + w * thetas[b]
                R0s[k] = sl([w]).as_matrix()[0]
                srcs[k] = "filled"
                filled.append(k)
        t = j
    return filled


def smooth_sequence(R0s, thetas, fps: float):
    """In place: One Euro on angles and on the wrist quaternion, per present run."""
    lo, hi = hm.limits_vector()
    mask = [th is not None for th in thetas]
    for s, e in present_runs(mask):
        th = np.stack(thetas[s:e])
        th = np.clip(one_euro(th, fps, **ANGLE_FILTER), lo, hi)
        q = Rotation.from_matrix(np.stack(R0s[s:e])).as_quat()
        for k in range(1, len(q)):  # keep quaternion signs continuous before filtering
            if np.dot(q[k], q[k - 1]) < 0:
                q[k] = -q[k]
        q = one_euro(q, fps, **ROT_FILTER)
        q /= np.linalg.norm(q, axis=1, keepdims=True)
        R = Rotation.from_quat(q).as_matrix()
        for k in range(s, e):
            thetas[k] = th[k - s]
            R0s[k] = R[k - s]


def hand_entries(R0s, thetas, side: str) -> list:
    """`hands3d` entries (FORMAT.md v2, without conf) for every frame that has a fit, else None."""
    idx = [t for t, th in enumerate(thetas) if th is not None]
    out = [None] * len(thetas)
    if not idx:
        return out
    R0 = np.stack([R0s[t] for t in idx])
    th = np.stack([thetas[t] for t in idx])
    pts, _ = hm.fk_batch(th)
    joints = np.einsum("tjc,tdc->tjd", pts, R0)  # right-hand space, camera axes
    rot = hm.theta_to_rot(R0, th)
    if side == "left":
        joints = joints @ MIRROR
        rot = hm.mirror_quat(rot)
    for k, t in enumerate(idx):
        out[t] = {"joints": round_points(joints[k].tolist()), "rot": round_points(rot[k].tolist())}
    return out


def confidence(base: float, fit_mm: float | None) -> float:
    """Source confidence, lowered when the fit is far from the observation. ~10 mm is normal for
    MediaPipe (its fingers are shorter than the anatomical skeleton's), so only the excess counts."""
    if fit_mm is None:
        return base
    return base * math.exp(-max(0.0, fit_mm - FIT_MM_FREE) / FIT_MM_SCALE)


def build_v2(raw: dict, clean: dict, video: str | None = None, keypoints: dict | None = None,
             redetect: bool = True, v1_hands: str = "fitted") -> tuple[dict, dict]:
    t0 = time.perf_counter()
    first, last = (clean.get("cleanup") or {}).get("trim") or [0, len(raw["frames"]) - 1]
    T = len(clean["frames"])
    assert last - first + 1 == T, "clean file does not match the raw file's trim"
    fps = float(clean["fps"])
    obs, stats = collect_observations(raw, first, last, video, keypoints, redetect)
    out = copy.deepcopy(clean)
    per_side = {}
    for side in SIDES:
        R0s, thetas, fits = fit_sequence(obs[side], side)
        srcs = [o["src"] if o else None for o in obs[side]]
        for t, mm in enumerate(fits):  # the skeleton cannot explain this observation: treat it as missing
            if mm is not None and mm > MAX_FIT_MM:
                R0s[t] = thetas[t] = fits[t] = srcs[t] = None
                obs[side][t] = None
                stats["dropped_bad_fit"] = stats.get("dropped_bad_fit", 0) + 1
        filled = fill_gaps(R0s, thetas, srcs)
        smooth_sequence(R0s, thetas, fps)
        per_side[side] = (R0s, thetas, fits, srcs, filled, hand_entries(R0s, thetas, side))
    src_counts = {}
    for t, f in enumerate(out["frames"]):
        h3 = {}
        for side in SIDES:
            R0s, thetas, fits, srcs, _, entries = per_side[side]
            e = entries[t]
            if e is None:
                h3[side] = None
                continue
            o = obs[side][t]
            e["conf"] = rnd(confidence(o["conf"] if o else SOURCE_CONF["filled"], fits[t]), 3)
            e["src"] = srcs[t]
            e["fit_mm"] = rnd(fits[t], 2) if fits[t] is not None else None
            h3[side] = e
            src_counts[f"{side}:{srcs[t]}"] = src_counts.get(f"{side}:{srcs[t]}", 0) + 1
        f["hands3d"] = h3
    v1_written = write_v1_hands(out, obs) if v1_hands == "fitted" else {}
    out["version"] = 2
    out["hands3d_meta"] = {
        "model": "sbp-hand-skeleton v1 (motion/hand_model.py)",
        "joint_order": "mediapipe-21",
        "rot_order": "mano-16 (wrist, index1-3, middle1-3, pinky1-3, ring1-3, thumb1-3)",
        "axes": "camera: x right, y down, z away (same as poseWorld); joints wrist-relative, metres",
        "rest_right": round_points(hm.REST.tolist()),
        "rest_order": "mano-16 + tips (thumb, index, middle, ring, pinky)",
        "left": "mirror of right: rest x -> -x, quaternion (qx,-qy,-qz,qw)",
        "joint_limits_deg": hm.JOINT_LIMITS,
        "param_names": hm.PARAM_NAMES,
        "smoothing": {"angles": ANGLE_FILTER, "wrist_rotation": ROT_FILTER, "max_fill": MAX_FILL},
        "sources": src_counts,
        "keypoints": (keypoints or {}).get("model"),
        "redetect": stats,
        "v1_hands": v1_hands,
        "v1_filled_frames": v1_written,
    }
    return out, {"seconds": round(time.perf_counter() - t0, 2), **stats, "sources": src_counts}


def write_v1_hands(out: dict, obs: dict) -> dict:
    """Replace left/rightHandWorld with the fitted skeleton, scaled to the clip's MediaPipe hand
    size and anchored on the poseWorld wrist; give frames that had no v1 hand image points from the
    re-detection (or a projection of the fitted hand). Returns {part: [frames given image points]}."""
    written = {}
    for side in SIDES:
        part, wpart = f"{side}Hand", f"{side}HandWorld"
        sizes, px = [], []
        for t, f in enumerate(out["frames"]):
            if f.get(wpart) is not None:
                w = np.array(f[wpart])
                sizes.append(np.linalg.norm(w[9] - w[0]))
            if f.get(part) is not None:
                im = np.array(f[part]) * [out["width"], out["height"], out["width"]]
                px.append(np.linalg.norm(im[9, :2] - im[0, :2]))
        rest_palm = float(np.linalg.norm(hm.REST_MP[9]))
        k_world = (float(np.median(sizes)) / rest_palm) if sizes else 1.0
        k_px = (float(np.median(px)) / rest_palm) if px else None
        for t, f in enumerate(out["frames"]):
            h = (f.get("hands3d") or {}).get(side)
            if h is None:
                continue
            J = np.array(h["joints"])
            if f.get("poseWorld") is not None:
                anchor = np.array(f["poseWorld"][POSE_WRIST[side]][:3])
                f[wpart] = round_points((anchor + k_world * J).tolist())
            if f.get(part) is None:
                o = obs[side][t]
                if o is not None and o.get("image") is not None:
                    f[part] = round_points(o["image"])
                elif k_px is not None and f.get("pose") is not None:
                    wr = np.array(f["pose"][POSE_WRIST[side]][:2]) * [out["width"], out["height"]]
                    im = np.empty((21, 3))
                    im[:, :2] = wr + k_px * J[:, :2]
                    im[:, 2] = k_px * J[:, 2]
                    f[part] = round_points((im / [out["width"], out["height"], out["width"]]).tolist())
                else:
                    continue
                written.setdefault(part, []).append(t)
    return written


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("raw")
    ap.add_argument("--clean", required=True, help="the matching .clean.json (frames and trim)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--video", help="source video, for re-detecting missed hands")
    ap.add_argument("--keypoints", help="hands_gpu.py output (.wilor.json) to use instead of MediaPipe hands")
    ap.add_argument("--no-redetect", action="store_true")
    ap.add_argument("--v1-hands", choices=["fitted", "keep"], default="fitted")
    ap.add_argument("--allow-stub", action="store_true", help="accept --keypoints made with a stub MANO (tests only)")
    a = ap.parse_args(argv)
    raw, clean = load_json(a.raw), load_json(a.clean)
    kp = load_json(a.keypoints) if a.keypoints else None
    if kp is not None and kp.get("mano") == "stub" and not a.allow_stub:
        raise SystemExit(f"{a.keypoints} was made with --mano stub (plumbing test): its joints are meaningless. "
                         "Re-run hands_gpu.py with the real MANO_RIGHT.pkl, or pass --allow-stub to test.")
    v2, st = build_v2(raw, clean, a.video, kp, not a.no_redetect, a.v1_hands)
    save_json(v2, a.out)
    print(json.dumps({"out": a.out, "frames": len(v2["frames"]), **st}))


if __name__ == "__main__":
    sys.exit(main())
