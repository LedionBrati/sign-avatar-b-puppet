"""Compare MediaPipe hands with the fitted anatomical hands of a `.v2.json`, with numbers and a PNG grid.

    uv run python hands_report.py --raw X.raw.json --clean X.clean.json --v2 X.v2.json \
        --video <signs>/videos/X.mp4 --out-dir ../out/hands3d/X-report

Writes `summary.json` and `grid.png` (per picked frame: the video crop with MediaPipe's hand in red,
the same crop with the fitted hand in green, and both hands seen from the thumb side in the hand's own frame).

Numbers, per hand, over the frames of the clean (trimmed) file:
- detected %: frames with a hand (raw Holistic / clean after gap fill / v2 fitted).
- impossible %: hand-frames where the 21 points imply a pose no hand can make
  (hand_model.impossible_joints: a finger hinge bent backwards or sideways, a knuckle or thumb
  far out of range).
- tip jitter: mean |p[t+1] - 2 p[t] + p[t-1]| of the 5 fingertips relative to the wrist, in % of
  the wrist -> middle knuckle length, over frames present in both. Lower = steadier.
- angle jitter: the same 2nd difference on the 12 long-finger flexion angles, degrees.
- motion kept: 95th percentile of the per-frame change of those 12 angles (handshape speed),
  B / A. Near 1.0 = fast handshape changes survive the smoothing. Measured on angles because
  the fitted hand has anatomical finger lengths and MediaPipe's are shorter, so fingertip
  distances are not comparable between the two (tip jitter is shown, but read it with that in mind).
- bone length CV: spread of each finger bone's length over time, % (MediaPipe "stretches" bones).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import hand_model as hm  # first: pins BLAS threads
import cv2
import numpy as np

from common import load_json

SIDES = ("left", "right")
MIRROR = np.diag([-1.0, 1.0, 1.0])
TIPS = [4, 8, 12, 16, 20]
BONES = [(a, b) for ch in hm.FINGERS.values() for a, b in zip([0] + ch[:-1], ch)]
EDGES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11),
         (11, 12), (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]


def _pts(frame, side, W, H):
    w = frame.get(f"{side}HandWorld")
    if w is not None:
        return np.array(w, float)
    im = frame.get(f"{side}Hand")
    return None if im is None else np.array(im, float) * [W, H, W]


def _right(p, side):
    return p @ MIRROR if side == "left" else p


def series(motion_frames, side, W, H, first=0, n=None, key="v1"):
    n = n if n is not None else len(motion_frames) - first
    out = []
    for t in range(n):
        f = motion_frames[first + t]
        if key == "v2":
            h = (f.get("hands3d") or {}).get(side)
            out.append(None if h is None else np.array(h["joints"], float))
        else:
            out.append(_pts(f, side, W, H))
    return out


def _norm(p):
    p = p - p[0]
    return p / max(np.linalg.norm(p[9]), 1e-9)


def metrics(seq: list, side: str) -> dict:
    T = len(seq)
    present = [p is not None for p in seq]
    imp = [bool(hm.impossible_joints(_right(p, side))) for p in seq if p is not None]
    bl = np.array([[np.linalg.norm(p[b] - p[a]) / max(np.linalg.norm(p[9] - p[0]), 1e-9) for a, b in BONES]
                   for p in seq if p is not None])
    return {
        "detected_pct": round(100 * sum(present) / max(T, 1), 1),
        "impossible_pct": round(100 * float(np.mean(imp)), 1) if imp else None,
        "impossible_frames": int(sum(imp)),
        "bone_cv_pct": round(100 * float(np.mean(bl.std(0) / np.maximum(bl.mean(0), 1e-9))), 2) if len(bl) > 1 else None,
    }


def _flex12(p, side):
    a = hm.raw_angles(_right(p, side))
    return np.array([a[f]["flex"][k] for f in ("index", "middle", "ring", "pinky") for k in range(3)])


def paired(seq_a: list, seq_b: list, side: str) -> dict:
    """Jitter of A and B over the frame triplets present in both."""
    T = len(seq_a)
    trip = [t for t in range(1, T - 1) if all(seq_a[k] is not None and seq_b[k] is not None for k in (t - 1, t, t + 1))]
    if not trip:
        return {"triplets": 0}
    res = {"triplets": len(trip)}
    for name, seq in (("a", seq_a), ("b", seq_b)):
        N = {t: _norm(seq[t]) for t in set(k for t in trip for k in (t - 1, t, t + 1))}
        tj = [np.mean(np.linalg.norm((N[t + 1] - 2 * N[t] + N[t - 1])[TIPS], axis=1)) for t in trip]
        A = {t: _flex12(seq[t], side) for t in N}
        aj = [np.mean(np.abs(A[t + 1] - 2 * A[t] + A[t - 1])) for t in trip]
        sp = [np.mean(np.abs(A[t + 1] - A[t])) for t in trip]
        res[name] = {"tip_jitter_pct": round(100 * float(np.mean(tj)), 2),
                     "angle_jitter_deg": round(float(np.mean(aj)), 2),
                     "angle_speed_p95_deg": round(float(np.percentile(sp, 95)), 2)}
    res["motion_kept"] = round(res["b"]["angle_speed_p95_deg"] / max(res["a"]["angle_speed_p95_deg"], 1e-9), 2)
    return res


# ---------------------------------------------------------------- drawing

def _draw(img, P, color, thick=2):
    for a, b in EDGES:
        cv2.line(img, tuple(int(v) for v in P[a]), tuple(int(v) for v in P[b]), color, thick, cv2.LINE_AA)
    for k in range(21):
        cv2.circle(img, tuple(int(v) for v in P[k]), 3 if k in TIPS else 2, color, -1, cv2.LINE_AA)


def _palm_similarity(src, dst, palm=(0, 5, 9, 13, 17)):
    """Map 2D points `src` with the scale+rotation+shift that best lays src's palm on dst's palm."""
    a, b = src[list(palm)], dst[list(palm)]
    ca, cb = a.mean(0), b.mean(0)
    A, B = a - ca, b - cb
    za, zb = A[:, 0] + 1j * A[:, 1], B[:, 0] + 1j * B[:, 1]
    k = np.vdot(za, zb) / max(np.vdot(za, za).real, 1e-12)  # complex least squares: scale * rotation
    z = (src[:, 0] - ca[0]) + 1j * (src[:, 1] - ca[1])
    w = k * z
    return np.stack([w.real + cb[0], w.imag + cb[1]], 1)


def _side_view(p, side, size):
    """Points seen from the thumb side in the hand's own frame (fingers up, palm to the right), so
    curled fingers show as curled. Scaled to `size`."""
    q = _right(p, side)
    q = q - q[0]
    R = hm.global_rotation(q)
    c = (q @ R) / max(np.linalg.norm(q[9]), 1e-9)  # canonical, palm length 1
    # canonical x = fingers (drawn upward), y = palmar (drawn to the right)
    u = np.stack([c[:, 1], -c[:, 0]], 1) * size * 0.40 + [size * 0.35, size * 0.85]
    return u


def grid(video, raw, v2, side, out_png, n=6):
    W, H = raw["width"], raw["height"]
    first = (v2.get("cleanup") or {}).get("trim", [0])[0]
    T = len(v2["frames"])
    rawseq = series(raw["frames"], side, W, H, first, T)
    fit = series(v2["frames"], side, W, H, 0, T, key="v2")
    bad = [t for t in range(T) if rawseq[t] is not None and fit[t] is not None
           and hm.impossible_joints(_right(rawseq[t], side))]
    extra = [t for t in range(T) if fit[t] is not None and v2["frames"][t]["hands3d"][side]["src"] != "holistic"]
    even = [t for t in np.linspace(0, T - 1, n + 2).astype(int)[1:-1] if fit[t] is not None]
    pick = []
    for t in bad[:3] + extra[:2] + even:
        if t not in pick and len(pick) < n:
            pick.append(int(t))
    pick.sort()
    if not pick:
        return None
    cap = cv2.VideoCapture(str(video))
    frames, i = {}, 0
    want = {first + t for t in pick}
    while i <= max(want):
        ok, bgr = cap.read()
        if not ok:
            break
        if i in want:
            frames[i] = cv2.flip(bgr, 1) if raw.get("mirrored") else bgr
        i += 1
    cap.release()
    S = 240
    rows = []
    for t in pick:
        f_raw, f_v2 = raw["frames"][first + t], v2["frames"][t]
        img = frames.get(first + t)
        if img is None:
            continue
        im = f_raw.get(f"{side}Hand")
        im_px = None if im is None else np.array(im)[:, :2] * [W, H]
        h = f_v2["hands3d"][side]
        J = np.array(h["joints"])
        # place the fitted hand on the picture: a 2D similarity that lays its palm (wrist + knuckles)
        # on the tracked palm, so only the fingers differ. Image points: Holistic's, else the v2 file's
        # (re-detection), else the pose wrist with the clip's typical scale.
        ref = im_px
        if ref is None and f_v2.get(f"{side}Hand"):
            ref = np.array(f_v2[f"{side}Hand"])[:, :2] * [W, H]
        if ref is not None:
            fit_px = _palm_similarity(J[:, :2], ref)
        else:
            anchor = np.array(f_raw["pose"][15 if side == "left" else 16][:2]) * [W, H]
            fit_px = anchor + 900.0 * J[:, :2]
        allp = fit_px if im_px is None else np.concatenate([fit_px, im_px])
        lo, hi = allp.min(0), allp.max(0)
        c, s = (lo + hi) / 2, max(hi - lo) * 1.5 + 20
        x0, y0 = int(c[0] - s / 2), int(c[1] - s / 2)
        M = np.array([[S / s, 0, -x0 * S / s], [0, S / s, -y0 * S / s]])
        crop = cv2.warpAffine(img, M, (S, S), flags=cv2.INTER_CUBIC)
        a, b = crop.copy(), crop.copy()
        to = lambda P: (P - [x0, y0]) * (S / s)  # noqa: E731
        if im_px is not None:
            _draw(a, to(im_px), (40, 40, 230))
        _draw(b, to(fit_px), (60, 200, 60))
        view = np.full((S, S, 3), 255, np.uint8)
        if rawseq[t] is not None:
            _draw(view, _side_view(rawseq[t], side, S), (40, 40, 230), 1)
        _draw(view, _side_view(J, side, S), (60, 160, 60), 2)
        nb = len(hm.impossible_joints(_right(rawseq[t], side))) if rawseq[t] is not None else None
        cv2.putText(a, f"f{t} MediaPipe" + ("" if nb is None else f" bad:{nb}") + (" (none)" if im_px is None else ""),
                    (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(b, f"fitted ({h['src']}) conf {h['conf']}", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                    (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(view, "side view: red MP, green fit", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 1,
                    cv2.LINE_AA)
        rows.append(np.concatenate([a, b, view], 1))
    if not rows:
        return None
    half = (len(rows) + 1) // 2
    if len(rows) > 3:
        left, right = rows[:half], rows[half:]
        while len(right) < len(left):
            right.append(np.full_like(rows[0], 255))
        out = np.concatenate([np.concatenate(left, 0), np.full((S * half, 8, 3), 255, np.uint8),
                              np.concatenate(right, 0)], 1)
    else:
        out = np.concatenate(rows, 0)
    Path(out_png).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_png), out)
    return pick


def report(raw, clean, v2, video=None, out_dir=None) -> dict:
    W, H = raw["width"], raw["height"]
    first = (clean.get("cleanup") or {}).get("trim", [0])[0]
    T = len(clean["frames"])
    out = {"name": v2["name"], "frames": T, "sides": {}}
    for side in SIDES:
        r = series(raw["frames"], side, W, H, first, T)
        c = series(clean["frames"], side, W, H, 0, T)
        f = series(v2["frames"], side, W, H, 0, T, key="v2")
        if not any(x is not None for x in r + f):
            continue
        fits = [v2["frames"][t]["hands3d"][side]["fit_mm"] for t in range(T) if f[t] is not None
                and v2["frames"][t]["hands3d"][side].get("fit_mm") is not None]
        out["sides"][side] = {
            "raw": metrics(r, side), "clean": metrics(c, side), "v2": metrics(f, side),
            "raw_vs_v2": paired(r, f, side), "raw_vs_clean": paired(r, c, side),
            "fit_mm_p50_p90": [round(float(np.percentile(fits, q)), 1) for q in (50, 90)] if fits else None,
            "sources": {s: sum(1 for t in range(T) if f[t] is not None and v2["frames"][t]["hands3d"][side]["src"] == s)
                        for s in ("holistic", "redetect", "wilor", "filled")},
        }
        if video and out_dir:
            out["sides"][side]["grid_frames"] = grid(video, raw, v2, side, Path(out_dir) / f"grid-{side}.png")
    if out_dir:
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        (Path(out_dir) / "summary.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--clean", required=True)
    ap.add_argument("--v2", required=True)
    ap.add_argument("--video")
    ap.add_argument("--out-dir")
    a = ap.parse_args(argv)
    res = report(load_json(a.raw), load_json(a.clean), load_json(a.v2), a.video, a.out_dir)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    sys.exit(main())
