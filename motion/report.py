"""Finger-tracking quality report for one clip (GitHub issue #2).

    uv run python report.py ../out/motion/judy.raw.json ../out/motion/judy.clean.json \
        --video ../references/how2sign/judy.mp4 --out-dir ../out/motion/judy-report

Writes to --out-dir:
  report.md              human summary: detection %, tracking-loss ranges, jumps, jitter raw vs clean
  frames.csv             one row per frame with every per-hand measure
  summary.json           the key numbers, machine readable
  <name>-overlay.mp4     source + pose/hands/face contour, lost hands marked in red
  <name>-skeleton.mp4    source | skeleton from the clean file, side by side
  worst-*.png            hand crops of the 6 worst frames (+ worst-frames.png contact sheet)

The report only says where the TRACKER is unsure or inconsistent. It cannot say whether a
handshape is right: only a fluent signer can judge that.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from mediapipe.tasks.python.vision import (
    FaceLandmarksConnections as FC,
    HandLandmarksConnections as HC,
    PoseLandmarksConnections as PC,
)

from clean import BOTTOM_EDGE, REST_LINE, REST_SPEED, REST_VIS, _body_refs, _pose_arr, _wrist_speed, present_runs
from common import FINGERTIPS, HAND_PARTS, L_WRIST, POSE_WRIST, R_WRIST, load_json

# thresholds (shoulder widths, "SW", are the body-size unit; image coords otherwise)
FAST_SPEED = 0.08  # wrist faster than this (SW/frame, ~2 SW/s at 24 fps) -> likely motion blur
HANDS_CLOSE = 0.6  # pose wrists closer than this -> hands touching/crossing
JUMP_DIST = 0.6  # hand-wrist to pose-wrist distance above this -> implausible
JUMP_DELTA = 0.35  # change of that distance between frames above this -> jump
SCALE_RANGE = (0.5, 2.0)  # palm size vs clip median outside this -> implausible
POSE_INDEX = {"leftHand": 19, "rightHand": 20}  # pose "index finger" points
POSE_HAND_PTS = {"leftHand": [15, 17, 19, 21], "rightHand": [16, 18, 20, 22]}  # wrist, pinky, index, thumb
POSE_ELBOW = {"leftHand": 13, "rightHand": 14}
ARM_CLOSE = 0.3  # hand within this many SW of the other forearm -> hands touching/crossing
PALM = [0, 5, 9, 13, 17]
FACE_BELOW = 0.7  # face box for "hand at face/chin" reaches this many face heights below the chin


def palm_size(h: np.ndarray, W: int, H: int) -> np.ndarray:
    """Largest distance between palm landmarks (pixels): less sensitive to hand orientation than one bone."""
    px = h[:, PALM, :2] * np.array([W, H])
    d = np.linalg.norm(px[:, :, None, :] - px[:, None, :, :], axis=-1)
    return d.reshape(len(h), -1).max(axis=1)


def seg_dist(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Distance from points p (T,2) to segments a-b (T,2), elementwise over T."""
    ab = b - a
    t = np.clip(np.sum((p - a) * ab, axis=1) / np.maximum(np.sum(ab * ab, axis=1), 1e-9), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)


OTHER = {"leftHand": "rightHand", "rightHand": "leftHand"}
COLOR = {"leftHand": (255, 160, 0), "rightHand": (0, 200, 255)}  # BGR: left blue-ish, right orange
SHORT = {"leftHand": "L", "rightHand": "R"}


# ---------------------------------------------------------------- analysis

def hand_arr(frames, part):
    out = np.full((len(frames), 21, 3), np.nan)
    for i, f in enumerate(frames):
        if f.get(part) is not None:
            out[i] = np.array(f[part], dtype=float)[:, :3]
    return out


def tip_displacement(h: np.ndarray, W: int, H: int) -> np.ndarray:
    """Mean frame-to-frame fingertip displacement in pixels (NaN where t-1 or t missing)."""
    tips = h[:, FINGERTIPS, :2] * np.array([W, H])
    d = np.full(len(h), np.nan)
    d[1:] = np.mean(np.hypot(*(tips[1:] - tips[:-1]).transpose(2, 0, 1)), axis=1)
    return d


def tip_second_diff(h: np.ndarray, W: int, H: int) -> np.ndarray:
    """Jitter: mean distance of each fingertip from the midpoint of its neighbours in time, pixels.
    Smooth motion (even fast) gives small values; frame-to-frame noise gives large ones."""
    tips = h[:, FINGERTIPS, :2] * np.array([W, H])
    d = np.full(len(h), np.nan)
    mid = (tips[:-2] + tips[2:]) / 2
    d[1:-1] = np.mean(np.hypot(*(tips[1:-1] - mid).transpose(2, 0, 1)), axis=1)
    return d


def local_tip_displacement(h: np.ndarray, W: int, H: int) -> np.ndarray:
    """Frame-to-frame change of fingertips RELATIVE to the hand's wrist, in hand sizes.
    This is handshape change (curl/spread) with the arm motion removed. "Hand size" = palm size."""
    px = h[..., :2] * np.array([W, H])
    size = palm_size(h, W, H)  # palm size, robust to orientation
    rel = (px[:, FINGERTIPS] - px[:, [0]]) / size[:, None, None]
    d = np.full(len(h), np.nan)
    d[1:] = np.mean(np.hypot(*(rel[1:] - rel[:-1]).transpose(2, 0, 1)), axis=1)
    return d


def runs_to_ranges(mask) -> list[tuple[int, int]]:
    return [(s, e - 1) for s, e in present_runs(mask)]


def analyse(raw: dict, clean: dict | None) -> dict:
    frames = raw["frames"]
    T, W, H, fps = len(frames), raw["width"], raw["height"], float(raw["fps"])
    pose = _pose_arr(frames)
    sh_y, hip_y, sw = _body_refs(pose)
    rest_y = sh_y + REST_LINE * (hip_y - sh_y)

    # face box per frame (for "hand in front of face")
    face_box = np.full((T, 4), np.nan)
    for i, f in enumerate(frames):
        if f.get("face"):
            a = np.array(f["face"])[:, :2]
            (x0, y0), (x1, y1) = a.min(0), a.max(0)
            mx, my = 0.15 * (x1 - x0), 0.15 * (y1 - y0)
            # extend well below the chin: the pose model places hand points too low when a hand is at
            # the mouth/chin (seen on travis f62/f98, floyd f208), so a tight face box misses them
            face_box[i] = [x0 - mx, y0 - my, x1 + mx, y1 + FACE_BELOW * (y1 - y0)]

    # clean file may be trimmed; map raw frame -> clean frame
    c_off = clean["cleanup"]["trim"][0] if clean else 0
    c_frames = clean["frames"] if clean else []

    def clean_frame(i):
        k = i - c_off
        return c_frames[k] if 0 <= k < len(c_frames) else None

    wrist_dist_pw = np.hypot(*(pose[:, L_WRIST, :2] - pose[:, R_WRIST, :2]).T) / sw

    per = {}
    for part in HAND_PARTS:
        pidx = POSE_WRIST[part]
        h = hand_arr(frames, part)
        present = ~np.isnan(h[:, 0, 0])
        pw = pose[:, pidx, :2]
        vis = pose[:, pidx, 3]
        speed = _wrist_speed(pose, pidx, sw)
        visible = vis >= REST_VIS
        in_frame = visible & (pw[:, 1] < BOTTOM_EDGE)
        raised = in_frame & (pw[:, 1] < rest_y)
        moving = in_frame & (speed >= REST_SPEED)
        active = raised | moving
        lost = active & ~present

        # context tags
        ip = pose[:, POSE_INDEX[part], :2]
        # candidate hand points: pose wrist/pinky/index/thumb, plus the hand's own wrist and middle MCP if tracked
        cand = [pose[:, j, :2] for j in POSE_HAND_PTS[part]] + [h[:, 0, :2], h[:, 9, :2]]
        in_face = np.zeros(T, dtype=bool)
        for c in cand:
            in_face |= ((c[:, 0] > face_box[:, 0]) & (c[:, 0] < face_box[:, 2])
                        & (c[:, 1] > face_box[:, 1]) & (c[:, 1] < face_box[:, 3]))
        o = OTHER[part]
        fa, fb = pose[:, POSE_ELBOW[o], :2], pose[:, POSE_WRIST[o], :2]
        near_arm = np.min([seg_dist(np.nan_to_num(c, nan=9.0), fa, fb) for c in cand[:4]], axis=0) / sw < ARM_CLOSE
        close = (wrist_dist_pw < HANDS_CLOSE) | near_arm
        fast = speed >= FAST_SPEED
        edge = (pw[:, 0] < 0.03) | (pw[:, 0] > 0.97) | (pw[:, 1] > 0.95) | (ip[:, 1] > 0.97)

        # implausible hand: far from pose wrist, sudden distance change, swapped side, size spike
        d_own = np.hypot(*(h[:, 0, :2] - pw).T) / sw
        d_other = np.hypot(*(h[:, 0, :2] - pose[:, POSE_WRIST[OTHER[part]], :2]).T) / sw
        dd = np.full(T, np.nan)
        dd[1:] = np.abs(d_own[1:] - d_own[:-1])
        size = palm_size(h, W, H)
        med_size = np.nanmedian(size) if present.any() else np.nan
        scale = size / med_size
        far = present & (d_own > JUMP_DIST)
        jump = present & (dd > JUMP_DELTA)
        swap = present & (d_other + 0.1 < d_own)
        scale_bad = present & ((scale < SCALE_RANGE[0]) | (scale > SCALE_RANGE[1]))
        implausible = far | jump | swap | scale_bad

        disp_raw = tip_displacement(h, W, H)
        sd_raw = tip_second_diff(h, W, H)
        ldisp_raw = local_tip_displacement(h, W, H)
        if clean:
            hc = np.full((T, 21, 3), np.nan)
            filled = np.zeros(T, dtype=bool)
            fset = set(clean["cleanup"]["filled_frames"].get(part, []))
            for i in range(T):
                cf = clean_frame(i)
                if cf is not None and cf.get(part) is not None:
                    hc[i] = np.array(cf[part])[:, :3]
                    filled[i] = (i - c_off) in fset
            disp_clean = tip_displacement(hc, W, H)
            sd_clean = tip_second_diff(hc, W, H)
            ldisp_clean = local_tip_displacement(hc, W, H)
            dev = np.mean(np.hypot(*((hc[:, FINGERTIPS, :2] - h[:, FINGERTIPS, :2]) * np.array([W, H])).transpose(2, 0, 1)), axis=1)
            present_clean = ~np.isnan(hc[:, 0, 0])
        else:
            hc = None
            filled = np.zeros(T, dtype=bool)
            disp_clean = ldisp_clean = dev = sd_clean = np.full(T, np.nan)
            present_clean = np.zeros(T, dtype=bool)

        both = ~np.isnan(disp_raw) & ~np.isnan(disp_clean)
        both3 = ~np.isnan(sd_raw) & ~np.isnan(sd_clean)
        slow_f = both & (speed < REST_SPEED)
        fast_f = both & (speed >= FAST_SPEED)

        def m(x, sel):
            return float(np.nanmean(x[sel])) if sel.any() else None

        def p95(x, sel):
            return float(np.nanpercentile(x[sel], 95)) if sel.any() else None

        ranges = []
        for s, e in runs_to_ranges(lost):
            sl = slice(s, e + 1)
            tags = []
            if fast[sl].any():
                tags.append("fast")
            if close[sl].any():
                tags.append("hands touching/crossing")
            if in_face[sl].any():
                tags.append("hand at face/chin")
            if edge[sl].any():
                tags.append("frame edge")
            if not tags:
                tags.append("no obvious cause")
            ranges.append({"start": s, "end": e, "frames": e - s + 1,
                           "t0": round(s / fps, 2), "t1": round((e + 1) / fps, 2), "tags": tags})

        per[part] = {
            "present": present, "present_clean": present_clean, "filled": filled,
            "active": active, "lost": lost, "raised": raised, "speed": speed,
            "in_face": in_face, "close": close, "fast": fast, "edge": edge,
            "d_own": d_own, "dd": dd, "scale": scale, "far": far, "jump": jump, "swap": swap,
            "scale_bad": scale_bad, "implausible": implausible,
            "disp_raw": disp_raw, "disp_clean": disp_clean, "sd_raw": sd_raw, "sd_clean": sd_clean, "ldisp_raw": ldisp_raw,
            "ldisp_clean": ldisp_clean, "dev": dev, "hc": hc,
            "summary": {
                "detected_pct": round(100 * present.mean(), 1) if T else 0.0,
                "detected_clean_pct": round(100 * present_clean.mean(), 1) if clean and T else None,
                "active_frames": int(active.sum()),
                "detected_when_active_pct": round(100 * present[active].mean(), 1) if active.any() else None,
                "lost_while_active_frames": int(lost.sum()),
                "lost_ranges": ranges,
                "filled_frames": int(filled.sum()),
                "implausible_frames": int(implausible.sum()),
                "implausible_by_kind": {"far": int(far.sum()), "jump": int(jump.sum()),
                                        "swap": int(swap.sum()), "scale": int(scale_bad.sum())},
                "implausible_list": [int(i) for i in np.where(implausible)[0]],
                "jitter_px_raw": m(disp_raw, both), "jitter_px_clean": m(disp_clean, both),
                "jitter_px_raw_slow": m(disp_raw, slow_f), "jitter_px_clean_slow": m(disp_clean, slow_f),
                "jitter_px_raw_fast": m(disp_raw, fast_f), "jitter_px_clean_fast": m(disp_clean, fast_f),
                "jitter2_px_raw": m(sd_raw, both3), "jitter2_px_clean": m(sd_clean, both3),
                "triples_compared": int(both3.sum()),
                "p95_px_raw": p95(disp_raw, both), "p95_px_clean": p95(disp_clean, both),
                "shape_change_raw": m(ldisp_raw, both), "shape_change_clean": m(ldisp_clean, both),
                "shape_p95_raw": p95(ldisp_raw, both), "shape_p95_clean": p95(ldisp_clean, both),
                "clean_dev_px_mean": m(dev, ~np.isnan(dev) & present), "clean_dev_px_max":
                    float(np.nanmax(dev[present])) if (present & ~np.isnan(dev)).any() else None,
                "pairs_compared": int(both.sum()), "slow_pairs": int(slow_f.sum()), "fast_pairs": int(fast_f.sum()),
            },
        }

    # badness for picking worst frames
    bad = np.zeros(T)
    why = [[] for _ in range(T)]
    for part in HAND_PARTS:
        p = per[part]
        for i in range(T):
            if p["lost"][i]:
                bad[i] += 3 + (1 if p["fast"][i] else 0)
                why[i].append(f"{SHORT[part]} lost")
            if p["implausible"][i]:
                bad[i] += 2 + min(float(np.nan_to_num(p["d_own"][i])), 3)
                kinds = [k for k in ("far", "jump", "swap", "scale_bad") if p[k][i]]
                why[i].append(f"{SHORT[part]} " + "/".join(k.replace("_bad", "") for k in kinds))
    order = np.argsort(-bad, kind="stable")
    worst = []
    for i in order:
        if bad[i] <= 0 or len(worst) >= 6:
            break
        if all(abs(int(i) - w) >= 4 for w in worst):
            worst.append(int(i))
    return {"T": T, "W": W, "H": H, "fps": fps, "sw": sw, "rest_y": rest_y, "pose": pose,
            "per": per, "bad": bad, "why": why, "worst": worst, "face_box": face_box, "c_off": c_off}


# ---------------------------------------------------------------- drawing

FACE_CONN = (FC.FACE_LANDMARKS_FACE_OVAL + FC.FACE_LANDMARKS_LIPS + FC.FACE_LANDMARKS_LEFT_EYE
             + FC.FACE_LANDMARKS_RIGHT_EYE + FC.FACE_LANDMARKS_LEFT_EYEBROW + FC.FACE_LANDMARKS_RIGHT_EYEBROW)
POSE_UPPER = [c for c in PC.POSE_LANDMARKS if c.start <= 24 and c.end <= 24 and c.start >= 11 and c.end >= 11]


def _px(p, W, H, ox=0, oy=0, s=1.0):
    return int(round(p[0] * W * s - ox)), int(round(p[1] * H * s - oy))


def draw_frame(img, f, W, H, hand_style=None, s=1.0, ox=0, oy=0, thick=1):
    """Draw pose (upper body), face contour, hands. hand_style: {part: (color, label)}."""
    if f.get("face"):
        fc = f["face"]
        for c in FACE_CONN:
            cv2.line(img, _px(fc[c.start], W, H, ox, oy, s), _px(fc[c.end], W, H, ox, oy, s), (200, 200, 200), 1, cv2.LINE_AA)
    if f.get("pose"):
        p = f["pose"]
        for c in POSE_UPPER:
            if p[c.start][3] >= 0.3 and p[c.end][3] >= 0.3:
                cv2.line(img, _px(p[c.start], W, H, ox, oy, s), _px(p[c.end], W, H, ox, oy, s), (80, 255, 80), 2 * thick, cv2.LINE_AA)
    for part in HAND_PARTS:
        hp = f.get(part)
        if hp is None:
            continue
        color = (hand_style or {}).get(part, (COLOR[part], None))[0]
        for c in HC.HAND_CONNECTIONS:
            cv2.line(img, _px(hp[c.start], W, H, ox, oy, s), _px(hp[c.end], W, H, ox, oy, s), color, thick + 1, cv2.LINE_AA)
        for j, q in enumerate(hp):
            cv2.circle(img, _px(q, W, H, ox, oy, s), 3 if j in FINGERTIPS else 2, color, -1, cv2.LINE_AA)


def _label(img, text, org, color, scale=0.5):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1, cv2.LINE_AA)


def read_frames(video):
    cap = cv2.VideoCapture(str(video))
    out = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        out.append(f)
    cap.release()
    return out


def ffmpeg_writer(path, w, h, fps):
    return subprocess.Popen(
        [os.environ.get("FFMPEG") or "ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
         "-r", str(fps), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", str(path)],
        stdin=subprocess.PIPE)


def render_videos(raw, clean, A, video, out_dir: Path, mirrored: bool):
    src = read_frames(video)
    if mirrored:
        src = [cv2.flip(f, 1) for f in src]
    T, W, H, fps = A["T"], A["W"], A["H"], A["fps"]
    n = min(T, len(src))
    name = raw["name"]
    ov = ffmpeg_writer(out_dir / f"{name}-overlay.mp4", W, H, fps)
    sk = ffmpeg_writer(out_dir / f"{name}-skeleton.mp4", 2 * W, H, fps)
    for i in range(n):
        f = raw["frames"][i]
        img = src[i].copy()
        draw_frame(img, f, W, H)
        y = 20
        _label(img, f"f{i}  {i / fps:5.2f}s", (8, y), (255, 255, 255))
        for part in HAND_PARTS:
            p = A["per"][part]
            pw = A["pose"][i, POSE_WRIST[part], :2]
            y += 20
            if p["lost"][i]:
                if np.all(np.isfinite(pw)):
                    cv2.circle(img, _px(pw, W, H), 28, (0, 0, 255), 2, cv2.LINE_AA)
                _label(img, f"{SHORT[part]} LOST (raised/moving)", (8, y), (60, 60, 255))
            elif not p["present"][i]:
                _label(img, f"{SHORT[part]} missing (at rest)", (8, y), (170, 170, 170))
            elif p["implausible"][i]:
                _label(img, f"{SHORT[part]} implausible", (8, y), (0, 165, 255))
            else:
                _label(img, f"{SHORT[part]} ok", (8, y), COLOR[part])
            if p["filled"][i]:
                _label(img, "filled in clean", (200, y), (0, 255, 255))
        ov.stdin.write(img.tobytes())

        canvas = np.zeros((H, 2 * W, 3), np.uint8)
        canvas[:, :W] = src[i]
        right = np.full((H, W, 3), 25, np.uint8)
        cf = None
        if clean:
            k = i - A["c_off"]
            cf = clean["frames"][k] if 0 <= k < len(clean["frames"]) else None
        if cf is not None:
            draw_frame(right, cf, W, H, thick=2)
            _label(right, "clean landmarks", (8, 20), (255, 255, 255))
        else:
            draw_frame(right, f, W, H, thick=2)
            _label(right, "raw landmarks" + (" (trimmed out)" if clean else ""), (8, 20), (255, 255, 255))
        canvas[:, W:] = right
        sk.stdin.write(canvas.tobytes())
    for w in (ov, sk):
        w.stdin.close()
        w.wait()
    return src


def hand_crop(src_img, f, part, A, i, out_path, cf=None):
    """Crop around one hand: [plain | raw landmarks | clean landmarks], upscaled."""
    W, H, sw = A["W"], A["H"], A["sw"]
    hp = f.get(part)
    if hp is not None:
        a = np.array(hp)[:, :2]
        c = (a.min(0) + a.max(0)) / 2
        size = max((a.max(0) - a.min(0)).max() * 1.6, 0.0)
    else:
        pw = A["pose"][i, POSE_WRIST[part], :2]
        ip = A["pose"][i, POSE_INDEX[part], :2]
        c = (pw + ip) / 2 if np.all(np.isfinite(ip)) else pw
        size = 0.0
    if not np.all(np.isfinite(c)):
        return False
    side = int(max(size * W, 0.8 * sw * W, 120))
    cx, cy = int(c[0] * W), int(c[1] * H)
    x0, y0 = cx - side // 2, cy - side // 2
    pad = cv2.copyMakeBorder(src_img, side, side, side, side, cv2.BORDER_CONSTANT, value=(40, 40, 40))
    crop = pad[y0 + side:y0 + 2 * side, x0 + side:x0 + 2 * side].copy()
    s = 300 / side
    big = cv2.resize(crop, (300, 300), interpolation=cv2.INTER_CUBIC)
    panels = [big]
    for frame_data, tag in ((f, "raw"), (cf, "clean")):
        if frame_data is None:
            continue
        pnl = big.copy()
        sub = {"i": 0, part: frame_data.get(part)}
        ox, oy = x0 * s, y0 * s
        draw_frame(pnl, sub, W, H, s=s, ox=ox, oy=oy, thick=1)
        _label(pnl, tag + ("" if frame_data.get(part) is not None else ": none"), (6, 18), (255, 255, 255))
        panels.append(pnl)
    sheet = np.hstack(panels)
    bar = np.zeros((26, sheet.shape[1], 3), np.uint8)
    _label(bar, f"frame {i}  {part}  {'; '.join(A['why'][i])}", (6, 18), (255, 255, 255))
    out = np.vstack([bar, sheet])
    cv2.imwrite(str(out_path), out)
    return out


def worst_crops(raw, clean, A, src, out_dir: Path):
    sheets, files = [], []
    for rank, i in enumerate(A["worst"], 1):
        if i >= len(src):
            continue
        parts = [p for p in HAND_PARTS if A["per"][p]["lost"][i] or A["per"][p]["implausible"][i]]
        for part in parts:
            cf = None
            if clean:
                k = i - A["c_off"]
                cf = clean["frames"][k] if 0 <= k < len(clean["frames"]) else None
            path = out_dir / f"worst-{rank}-f{i:04d}-{part}.png"
            img = hand_crop(src[i], raw["frames"][i], part, A, i, path, cf)
            if img is not False:
                sheets.append(img)
                files.append(path.name)
    if sheets:
        w = max(s.shape[1] for s in sheets)
        sheets = [cv2.copyMakeBorder(s, 0, 4, 0, w - s.shape[1], cv2.BORDER_CONSTANT, value=0) for s in sheets]
        cv2.imwrite(str(out_dir / "worst-frames.png"), np.vstack(sheets))
    return files


# ---------------------------------------------------------------- outputs

def write_csv(A, path):
    cols = ["i", "t"]
    keys = ["present", "present_clean", "filled", "active", "lost", "raised", "speed", "fast", "close",
            "in_face", "edge", "d_own", "dd", "scale", "far", "jump", "swap", "scale_bad",
            "disp_raw", "disp_clean", "sd_raw", "sd_clean", "ldisp_raw", "ldisp_clean", "dev"]
    for part in HAND_PARTS:
        cols += [f"{SHORT[part]}_{k}" for k in keys]
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for i in range(A["T"]):
            row = [i, round(i / A["fps"], 4)]
            for part in HAND_PARTS:
                p = A["per"][part]
                for k in keys:
                    v = p[k][i]
                    if isinstance(v, (bool, np.bool_)):
                        row.append(int(v))
                    elif v is None or (isinstance(v, float) and np.isnan(v)):
                        row.append("")
                    else:
                        row.append(round(float(v), 4))
            w.writerow(row)


def _f(v, nd=2):
    return "n/a" if v is None else f"{v:.{nd}f}"


def write_md(raw, clean, A, crops, path, video, stats):
    name = raw["name"]
    L = []
    L.append(f"# Finger-tracking report: {name}\n")
    L.append(f"Source `{raw['source']['file']}` ({raw['source'].get('dataset')}, {raw['source'].get('license')}, "
             f"signer {raw['source'].get('signer')}), {A['T']} frames at {A['fps']:g} fps, {A['W']}x{A['H']}, "
             f"mirrored: {raw.get('mirrored')}. Dominant hand (pose-wrist motion): **{(clean or raw).get('dominant_hand')}**.\n")
    L.append("This report only measures where MediaPipe is missing or inconsistent. It says nothing about whether a "
             "handshape is linguistically right; that needs a fluent signer.\n")
    L.append("## Detection\n")
    L.append("| | left hand | right hand |\n|---|---|---|")
    pl, pr = A["per"]["leftHand"]["summary"], A["per"]["rightHand"]["summary"]
    rows = [("detected, all frames (raw)", "detected_pct", 1), ("detected after clean (gap fill)", "detected_clean_pct", 1),
            ("frames where the pose wrist is raised or moving", "active_frames", 0),
            ("detected when raised/moving", "detected_when_active_pct", 1),
            ("LOST while raised/moving (frames)", "lost_while_active_frames", 0),
            ("gap-filled in clean (frames)", "filled_frames", 0),
            ("implausible frames (far/jump/swap/scale)", "implausible_frames", 0)]
    for label, k, nd in rows:
        a, b = pl[k], pr[k]
        fmt = (lambda v: "n/a" if v is None else (f"{v:.1f}%" if nd else str(v)))
        L.append(f"| {label} | {fmt(a)} | {fmt(b)} |")
    L.append(f"\nPose detected {100 * np.mean(~np.isnan(A['pose'][:, 0, 0])):.1f}% of frames, face "
             f"{100 * np.mean([f.get('face') is not None for f in raw['frames']]):.1f}%.\n")
    L.append("## Tracking lost while signing\n")
    L.append("A hand counts as *lost* when its pose wrist (15/16, visibility >= 0.5, not in the bottom "
             f"{100 * (1 - BOTTOM_EDGE):.0f}% of the frame) is above the rest line "
             f"(shoulder + {REST_LINE:.2f} x shoulder-to-hip) or moving >= {REST_SPEED} shoulder widths/frame, "
             "but no hand landmarks came back. Tags are automatic hints from the pose, not a diagnosis: "
             f"*fast* = wrist >= {FAST_SPEED} SW/frame (motion blur likely), *hands touching/crossing* = pose wrists "
             f"< {HANDS_CLOSE} SW apart or the hand within {ARM_CLOSE} SW of the other forearm, *hand at face/chin* = a pose or hand point inside the face box (extended below the chin), *frame edge* = near the border.\n")
    for part in HAND_PARTS:
        rs = A["per"][part]["summary"]["lost_ranges"]
        L.append(f"**{part}**: {len(rs)} range(s)\n")
        if rs:
            L.append("| frames | seconds | length | hints |\n|---|---|---|---|")
            for r in rs:
                L.append(f"| {r['start']}-{r['end']} | {r['t0']:.2f}-{r['t1']:.2f} | {r['frames']} | {', '.join(r['tags'])} |")
            L.append("")
    L.append("## Implausible hand landmarks\n")
    L.append(f"Hand wrist (landmark 0) more than {JUMP_DIST} SW from the pose wrist (*far*), that distance changing by more than "
             f"{JUMP_DELTA} SW in one frame (*jump*), the hand being closer to the OTHER pose wrist (*swap*), or palm size "
             f"(largest distance between landmarks 0/5/9/13/17) outside {SCALE_RANGE[0]}-{SCALE_RANGE[1]}x the clip median (*scale*).\n")
    for part in HAND_PARTS:
        s = A["per"][part]["summary"]
        lst = s["implausible_list"]
        L.append(f"- **{part}**: {s['implausible_frames']} frames {s['implausible_by_kind']}"
                 + (f": {', '.join(map(str, lst[:40]))}{' ...' if len(lst) > 40 else ''}" if lst else ""))
    L.append("\n## Jitter: raw vs clean\n")
    L.append("*Displacement* = mean frame-to-frame fingertip movement (5 tips, pixels) over frame pairs present in both "
             "files; it mixes real motion and noise. *Wrist still* frames still contain real finger motion (fingerspelling "
             "happens with a still wrist), so they are not a pure noise floor. *Wrist fast* = real motion that should survive "
             "cleaning. *2nd-difference jitter* = distance of each fingertip from the midpoint of its previous and next "
             "position: the best noise proxy here, though at 24 fps fast real handshape changes score too. *Shape change* = "
             "fingertips relative to the hand's wrist, in hand sizes per frame (curl/spread change with the arm removed); its "
             "95th percentile shows whether quick handshape transitions survive cleaning. *Clean deviation* = distance "
             "between clean and raw fingertips.\n")
    L.append("| | left raw | left clean | right raw | right clean |\n|---|---|---|---|---|")
    for label, kr, kc in [("displacement, all pairs, px/frame", "jitter_px_raw", "jitter_px_clean"),
                          ("displacement, wrist still", "jitter_px_raw_slow", "jitter_px_clean_slow"),
                          ("displacement, wrist fast", "jitter_px_raw_fast", "jitter_px_clean_fast"),
                          ("displacement 95th pct", "p95_px_raw", "p95_px_clean"),
                          ("2nd-difference jitter, px", "jitter2_px_raw", "jitter2_px_clean"),
                          ("shape change, hand sizes/frame", "shape_change_raw", "shape_change_clean"),
                          ("shape change 95th pct", "shape_p95_raw", "shape_p95_clean")]:
        nd = 3 if "shape" in label else 2
        L.append(f"| {label} | {_f(pl[kr], nd)} | {_f(pl[kc], nd)} | {_f(pr[kr], nd)} | {_f(pr[kc], nd)} |")
    L.append(f"| clean deviation from raw, mean / max px | {_f(pl['clean_dev_px_mean'])} / {_f(pl['clean_dev_px_max'])} | | "
             f"{_f(pr['clean_dev_px_mean'])} / {_f(pr['clean_dev_px_max'])} | |")
    L.append(f"\nPairs compared: left {pl['pairs_compared']} (slow {pl['slow_pairs']}, fast {pl['fast_pairs']}), "
             f"right {pr['pairs_compared']} (slow {pr['slow_pairs']}, fast {pr['fast_pairs']}).\n")
    if clean:
        c = clean["cleanup"]
        L.append(f"Clean settings: {c['smoothing']}, gap fill <= {c.get('max_gap')} frames, trim {c['trim']}.\n")
    L.append("## Worst frames\n")
    L.append("Picked by a badness score (lost while signing > implausible), at least 4 frames apart. Each PNG is "
             "[source crop | raw landmarks | clean landmarks].\n")
    for i in A["worst"]:
        L.append(f"- frame {i} ({i / A['fps']:.2f} s): {'; '.join(A['why'][i])}")
    L.append("")
    for c in crops:
        L.append(f"![{c}]({c})")
    L.append(f"\nVideos: `{name}-overlay.mp4` (lost hands circled in red), `{name}-skeleton.mp4` (source | clean skeleton).\n")
    if stats:
        L.append(f"Extraction: {stats}\n")
    Path(path).write_text("\n".join(L), encoding="utf-8")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("raw")
    ap.add_argument("clean", nargs="?")
    ap.add_argument("--video", required=True, help="the source video the raw file was extracted from")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--no-video", action="store_true", help="skip the overlay/skeleton videos and crops")
    ap.add_argument("--stats", help="optional JSON line from extract.py to quote in the report")
    a = ap.parse_args(argv)
    raw = load_json(a.raw)
    clean = load_json(a.clean) if a.clean else None
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    A = analyse(raw, clean)
    crops = []
    if not a.no_video:
        src = render_videos(raw, clean, A, a.video, out, raw.get("mirrored", False))
        crops = worst_crops(raw, clean, A, src, out)
    write_csv(A, out / "frames.csv")
    stats = None
    if a.stats:
        try:
            stats = json.loads(Path(a.stats).read_text().strip().splitlines()[-1])
        except Exception:
            stats = None
    write_md(raw, clean, A, crops, out / "report.md", a.video, stats)
    summ = {"name": raw["name"], "frames": A["T"], "dominant_hand": (clean or raw).get("dominant_hand"),
            "worst": A["worst"], "hands": {p: A["per"][p]["summary"] for p in HAND_PARTS}}
    (out / "summary.json").write_text(json.dumps(summ, indent=1), encoding="utf-8")
    brief = {p: {k: summ["hands"][p][k] for k in ("detected_pct", "detected_when_active_pct",
                                                    "lost_while_active_frames", "implausible_frames",
                                                    "jitter2_px_raw", "jitter2_px_clean")} for p in HAND_PARTS}
    print(json.dumps({"out_dir": str(out), "worst": A["worst"], **brief}))


if __name__ == "__main__":
    sys.exit(main())
