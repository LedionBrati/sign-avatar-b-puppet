"""Finger fidelity: does a generated video keep the fingers of its reference video?

    uv run python finger_fidelity.py pair --ref PUPPET.mp4 --gen GENERATED.mp4 --out DIR \
        [--segments phr-1.json] [--motion phr-1.clean.json] [--recognizer http://127.0.0.1:8788]
    uv run python finger_fidelity.py batch --pairs pairs.json --out DIR [--workers 6]

Both videos go through MediaPipe HolisticLandmarker (VIDEO mode), the same tracker the
motion files come from. Hands are matched by the SUBJECT's side (left with left), and frames
by time, so a 540x720 puppet and a 768x1024 repaint compare directly.

Per hand and frame we compute 15 finger joint flexion angles (3 per finger, from the 3D hand
world landmarks, so camera distance and image size cancel) and 4 spread angles between
neighbouring fingers. Each finger also gets a coarse state: E (extended), B (bent) or
C (curled), from the sum of its flexion angles. A "handshape change" is a frame where any
finger is E in one video and C in the other (pointing index -> fist counts; E -> B does not).

Reported (over frames inside sign segments when --segments is given, else all frames):
- mean / median / p90 joint angle error, degrees, over frames where both videos see the hand
- handshape change %: share of those hand-frames with at least one E<->C finger flip
- drop %: hand seen in the reference but not in the generated video
- extra %: hand seen in the generated video but not in the reference
- worst frames, saved as a PNG strip (top: reference crop, bottom: generated crop)
- optional: recognizer top-1 on each sign segment for both videos (when the server answers)
- optional: the same angle numbers against the motion file the puppet was driven by

Landmark caches go to %TEMP%/flux-finger-cache, never the repo.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import warnings
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CACHE = Path(os.environ.get("FINGER_CACHE", Path(tempfile.gettempdir()) / "flux-finger-cache"))
HANDS = ("left", "right")
FINGERS = ("thumb", "index", "middle", "ring", "pinky")
CHAINS = ((0, 1, 2, 3, 4), (0, 5, 6, 7, 8), (0, 9, 10, 11, 12), (0, 13, 14, 15, 16), (0, 17, 18, 19, 20))
SPREAD = (((1, 3), (5, 6)), ((5, 6), (9, 10)), ((9, 10), (13, 14)), ((13, 14), (17, 18)))
BONES = [(c[k], c[k + 1]) for c in CHAINS for k in range(4)]
# Finger state thresholds on the summed flexion (degrees). Thumb uses only MCP + IP.
EXT_MAX = {"thumb": 45.0, "other": 75.0}
CURL_MIN = {"thumb": 95.0, "other": 150.0}
DROP_PENALTY_DEG = 60.0  # worst-frame ranking only: a lost hand ranks like a 60 degree error


# ---------------------------------------------------------------- landmarks

def model_path() -> Path:
    env = os.environ.get("HOLISTIC_MODEL")
    candidates = [Path(env)] if env else []
    candidates.append(HERE / "models" / "holistic_landmarker.task")
    for p in candidates:
        if p.exists():
            return p
    sys.path.insert(0, str(HERE))
    from common import ensure_model  # downloads once from the public Google bucket
    return ensure_model()


def extract(video: Path, model: Path) -> dict:
    """Holistic on every frame -> {x543: [F,543,3] image coords, world: [F,2,21,3], fps, w, h}. NaN = missing."""
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    opts = vision.HolisticLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(model)),
                                            running_mode=vision.RunningMode.VIDEO)
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    xs, ws = [], []
    with vision.HolisticLandmarker.create_from_options(opts) as det:
        i, last = 0, -1
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            ts = max(int(round(i * 1000.0 / fps)), last + 1)
            last = ts
            r = det.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)), ts)
            a = np.full((543, 3), np.nan, np.float32)
            for lms, start, n in ((r.face_landmarks, 0, 468), (r.left_hand_landmarks, 468, 21),
                                  (r.pose_landmarks, 489, 33), (r.right_hand_landmarks, 522, 21)):
                for j, p in enumerate((lms or [])[:n]):
                    a[start + j] = (p.x, p.y, p.z)
            wd = np.full((2, 21, 3), np.nan, np.float32)
            for k, lms in enumerate((r.left_hand_world_landmarks, r.right_hand_world_landmarks)):
                for j, p in enumerate((lms or [])[:21]):
                    wd[k, j] = (p.x, p.y, p.z)
            xs.append(a)
            ws.append(wd)
            i += 1
    cap.release()
    if not xs:
        raise RuntimeError(f"{video}: no frames")
    return {"x543": np.stack(xs), "world": np.stack(ws), "fps": float(fps), "w": w, "h": h}


def cache_key(video: Path) -> Path:
    st = video.stat()
    key = hashlib.sha1(f"{video.resolve()}|{st.st_size}|{int(st.st_mtime)}|v1".encode()).hexdigest()[:16]
    return CACHE / f"{video.stem}-{key}.npz"


def landmarks(video: str | Path, model: Path | None = None) -> dict:
    video = Path(video)
    p = cache_key(video)
    if p.exists():
        try:
            z = np.load(p)
            return {"x543": z["x543"], "world": z["world"], "fps": float(z["fps"]), "w": int(z["w"]), "h": int(z["h"])}
        except (OSError, ValueError, KeyError):
            p.unlink()
    d = extract(video, model or model_path())
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.stem + f".{os.getpid()}.tmp.npz")
    np.savez_compressed(tmp, x543=d["x543"], world=d["world"], fps=d["fps"], w=d["w"], h=d["h"])
    os.replace(tmp, p)
    return d


def from_motion(path: str | Path) -> dict:
    """A FORMAT.md v1 motion file -> the same dict as landmarks() (hands only matter here)."""
    m = json.loads(Path(path).read_text(encoding="utf-8"))
    F = len(m["frames"])
    x = np.full((F, 543, 3), np.nan, np.float32)
    wd = np.full((F, 2, 21, 3), np.nan, np.float32)
    for i, f in enumerate(m["frames"]):
        for key, start, n in (("face", 0, 468), ("leftHand", 468, 21), ("pose", 489, 33), ("rightHand", 522, 21)):
            pts = f.get(key)
            if pts:
                x[i, start:start + n] = np.asarray([p[:3] for p in pts[:n]], np.float32)
        for k, key in enumerate(("leftHandWorld", "rightHandWorld")):
            pts = f.get(key)
            if pts:
                wd[i, k] = np.asarray(pts[:21], np.float32)
    return {"x543": x, "world": wd, "fps": float(m.get("fps") or 24), "w": m.get("width"), "h": m.get("height")}


def hand_points(d: dict) -> np.ndarray:
    """[F,2,21,3] hand points for angles: world coords where present, else aspect-corrected image coords."""
    img = np.stack([d["x543"][:, 468:489], d["x543"][:, 522:543]], 1).astype(np.float64)
    if d.get("w") and d.get("h"):
        img[..., 1] *= d["h"] / d["w"]
    out = d["world"].astype(np.float64).copy()
    miss = np.isnan(out).any(-1).any(-1)
    out[miss] = img[miss]
    return out


# ---------------------------------------------------------------- angles

def _angle(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    na, nb = np.linalg.norm(a, axis=-1), np.linalg.norm(b, axis=-1)
    cos = np.sum(a * b, -1) / np.maximum(na * nb, 1e-9)
    return np.degrees(np.arccos(np.clip(cos, -1, 1)))


def joint_angles(p: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """p [...,21,3] -> flexion [...,15] (thumb CMC,MCP,IP, then MCP,PIP,DIP per finger) and spread [...,4]."""
    flex = []
    for c in CHAINS:
        for k in range(1, 4):
            flex.append(_angle(p[..., c[k], :] - p[..., c[k - 1], :], p[..., c[k + 1], :] - p[..., c[k], :]))
    spread = [_angle(p[..., b1, :] - p[..., a1, :], p[..., b2, :] - p[..., a2, :]) for (a1, b1), (a2, b2) in SPREAD]
    return np.stack(flex, -1), np.stack(spread, -1)


def finger_states(flex: np.ndarray) -> np.ndarray:
    """flex [...,15] -> int states [...,5]: 0 = E, 1 = B, 2 = C."""
    curl = np.stack([flex[..., 1] + flex[..., 2]] + [flex[..., 3 * f:3 * f + 3].sum(-1) for f in range(1, 5)], -1)
    ext = np.array([EXT_MAX["thumb"]] + [EXT_MAX["other"]] * 4)
    cur = np.array([CURL_MIN["thumb"]] + [CURL_MIN["other"]] * 4)
    s = np.ones(curl.shape, np.int8)
    s[curl <= ext] = 0
    s[curl >= cur] = 2
    return s


def code(states) -> str:
    return "".join("EBC"[int(v)] for v in states)


# ---------------------------------------------------------------- comparison

def align(n_ref: int, fps_ref: float, n_gen: int, fps_gen: float, shift: int = 0) -> np.ndarray:
    """For each reference frame, the generated frame at the same time plus `shift` frames (-1 if outside)."""
    idx = np.round(np.arange(n_ref) * fps_gen / fps_ref).astype(int) + shift
    idx[(idx >= n_gen) | (idx < 0)] = -1
    return idx


def sign_mask(n: int, segments: list | None) -> tuple[np.ndarray, list]:
    """Frames inside sign segments (gloss != null), and the segments themselves."""
    if not segments:
        return np.ones(n, bool), []
    mask = np.zeros(n, bool)
    signs = [s for s in segments if s.get("gloss")]
    for s in signs:
        mask[max(0, s["start"]):min(n, s["end"] + 1)] = True
    return mask, signs


def compare(ref: dict, gen: dict, mask: np.ndarray, shift: int = 0) -> dict:
    """Angle / handshape / detection numbers for ref vs gen over masked reference frames."""
    pr, pg = hand_points(ref), hand_points(gen)
    idx = align(len(pr), ref["fps"], len(pg), gen["fps"], shift)
    ok_idx = idx >= 0
    pg_al = np.full_like(pr, np.nan)
    pg_al[ok_idx] = pg[idx[ok_idx]]
    fr, sr = joint_angles(pr)
    fg, sg = joint_angles(pg_al)
    det_r = ~np.isnan(fr).any(-1)          # [F,2]
    det_g = ~np.isnan(fg).any(-1)
    m = mask[:, None] & np.ones((1, 2), bool)
    both = det_r & det_g & m
    err = np.abs(fr - fg)                   # [F,2,15]
    serr = np.abs(sr - sg)
    st_r, st_g = finger_states(np.nan_to_num(fr)), finger_states(np.nan_to_num(fg))
    flip = ((st_r == 0) & (st_g == 2)) | ((st_r == 2) & (st_g == 0))   # [F,2,5]
    with warnings.catch_warnings():          # frames with a missing hand are all-NaN rows
        warnings.simplefilter("ignore", RuntimeWarning)
        frame_err = np.nanmean(err, -1)      # [F,2]

    def summary(sel: np.ndarray, cols: np.ndarray) -> dict:
        e = frame_err[sel]
        mc = m & cols[None, :]
        n_ref = int((det_r & mc).sum())
        return {
            "hand_frames_scored": int(sel.sum()),
            "mean_joint_err_deg": _r(e.mean()) if e.size else None,
            "median_joint_err_deg": _r(np.median(e)) if e.size else None,
            "p90_joint_err_deg": _r(np.percentile(e, 90)) if e.size else None,
            "mean_spread_err_deg": _r(serr[sel].mean()) if e.size else None,
            "handshape_change_pct": _r(100 * flip[sel].any(-1).mean()) if e.size else None,
            "finger_flip_pct": {f: _r(100 * flip[sel][:, k].mean()) if e.size else None for k, f in enumerate(FINGERS)},
            "finger_err_deg": {f: _r(err[sel][:, 3 * k:3 * k + 3].mean()) if e.size else None for k, f in enumerate(FINGERS)},
            "ref_hand_frames": n_ref,
            "drop_pct": _r(100 * (det_r & ~det_g & mc).sum() / n_ref) if n_ref else None,
            "extra_pct": _r(100 * (~det_r & det_g & mc).sum() / max(1, int(mc.sum()))),
        }

    out = {"all": summary(both, np.array([True, True]))}
    for k, hand in enumerate(HANDS):
        cols = np.array([k == 0, k == 1])
        out[hand] = summary(both & cols[None, :], cols)
    # per-frame rows for worst-frame ranking and segment scoring
    rank = np.where(both, frame_err, np.where(det_r & ~det_g & m, DROP_PENALTY_DEG, -1.0))
    out["_frame"] = {"rank": rank, "idx": idx, "det_r": det_r, "det_g": det_g, "st_r": st_r, "st_g": st_g,
                     "err": frame_err, "both": both}
    return out


def best_shift(ref: dict, gen: dict, mask: np.ndarray, max_shift: int) -> int:
    """Generated-video frame offset with the lowest joint error, for models that add a lead-in (DreamActor)
    or drift. Needs at least half of the zero-shift overlap so a tiny overlap cannot win by luck."""
    if max_shift <= 0:
        return 0
    base = compare(ref, gen, mask, 0)["all"]["hand_frames_scored"]
    best, best_err = 0, None
    for d in range(-max_shift, max_shift + 1):
        a = compare(ref, gen, mask, d)["all"]
        if a["hand_frames_scored"] < max(10, base // 2) or a["mean_joint_err_deg"] is None:
            continue
        if best_err is None or a["mean_joint_err_deg"] < best_err - 1e-9:
            best, best_err = d, a["mean_joint_err_deg"]
    return best


def _r(v, nd: int = 2):
    v = float(v)
    return None if not math.isfinite(v) else round(v, nd)


def segment_scores(cmp: dict, signs: list) -> list:
    rows = []
    f = cmp["_frame"]
    for s in signs:
        sl = slice(s["start"], s["end"] + 1)
        b = f["both"][sl]
        e = f["err"][sl][b]
        flips = (((f["st_r"][sl] == 0) & (f["st_g"][sl] == 2)) | ((f["st_r"][sl] == 2) & (f["st_g"][sl] == 0))).any(-1)[b]
        rows.append({"gloss": s["gloss"], "start": s["start"], "end": s["end"],
                     "mean_joint_err_deg": _r(e.mean()) if e.size else None,
                     "handshape_change_pct": _r(100 * flips.mean()) if e.size else None,
                     "hand_frames_scored": int(b.sum())})
    return rows


# ---------------------------------------------------------------- recognizer

def recognizer_up(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/health", timeout=2) as r:
            return bool(json.loads(r.read()).get("ok"))
    except (OSError, ValueError):
        return False


def recognize(url: str, x: np.ndarray) -> dict | None:
    hands = ~np.isnan(x[:, 468:489, 0]).all(1) | ~np.isnan(x[:, 522:543, 0]).all(1)
    idx = np.flatnonzero(hands)
    if not len(idx):
        return None
    x = x[idx[0]: idx[-1] + 1][:384]
    req = urllib.request.Request(f"{url}/recognize?mode=sign", data=np.ascontiguousarray(x, "<f4").tobytes(), method="POST",
                                 headers={"content-type": "application/octet-stream", "X-Frames": str(len(x))})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())
    except OSError:
        return None


def _norm(s: str | None) -> str:
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def recognizer_scores(url: str, ref: dict, gen: dict, idx: np.ndarray, signs: list, motion: dict | None = None) -> dict:
    """Top-1/top-5 per sign segment for the reference video, the generated video and (if given) the motion file."""
    rows = []
    top = lambda r: (r or {}).get("options", [{}])[0] if (r or {}).get("options") else {}
    for s in signs:
        a, b = s["start"], min(s["end"], len(ref["x543"]) - 1)
        g = idx[a:b + 1]
        g = g[g >= 0]
        want = _norm(s["gloss"])
        hit = lambda t: want in (_norm(t.get("label")), _norm(t.get("text")))
        top5 = lambda r: any(want in (_norm(o.get("label")), _norm(o.get("text"))) for o in (r or {}).get("options", []))
        res = {"ref": recognize(url, ref["x543"][a:b + 1]), "gen": recognize(url, gen["x543"][g]) if len(g) else None}
        if motion is not None:
            res["motion"] = recognize(url, motion["x543"][a:b + 1])
        row = {"gloss": s["gloss"]}
        for k, r in res.items():
            row[f"{k}_top1"] = top(r).get("label")
            row[f"{k}_hit"] = hit(top(r))
            row[f"{k}_top5"] = top5(r)
        row["agree"] = bool(row["ref_top1"]) and row["ref_top1"] == row["gen_top1"]
        rows.append(row)
    n = max(1, len(rows))
    out = {"url": url, "segments": rows, "agree_pct": _r(100 * sum(r["agree"] for r in rows) / n)}
    for k in ("motion", "ref", "gen"):
        if rows and f"{k}_hit" in rows[0]:
            out[f"{k}_top1_pct"] = _r(100 * sum(r[f"{k}_hit"] for r in rows) / n)
            out[f"{k}_top5_pct"] = _r(100 * sum(r[f"{k}_top5"] for r in rows) / n)
    return out


# ---------------------------------------------------------------- worst-frame strip

def worst_frames(cmp: dict, mask: np.ndarray, k: int = 8, gap: int = 8) -> list:
    f = cmp["_frame"]
    score = np.where(mask[:, None], f["rank"], -1.0)
    flat = [(float(score[i, h]), i, h) for i in range(len(score)) for h in range(2) if score[i, h] >= 0]
    flat.sort(reverse=True)
    picked = []
    for sc, i, h in flat:
        if all(abs(i - j) >= gap for _, j, _ in picked):
            picked.append((sc, i, h))
        if len(picked) == k:
            break
    return [{"frame": i, "gen_frame": int(f["idx"][i]), "hand": HANDS[h], "score_deg": _r(sc),
             "dropped": bool(f["det_r"][i, h] and not f["det_g"][i, h]),
             "ref_shape": code(f["st_r"][i, h]) if f["det_r"][i, h] else None,
             "gen_shape": code(f["st_g"][i, h]) if f["det_g"][i, h] else None} for sc, i, h in picked]


def read_frames(video: Path, wanted: set) -> dict:
    import cv2
    cap = cv2.VideoCapture(str(video))
    out, i = {}, 0
    last = max(wanted) if wanted else -1
    while i <= last:
        ok, bgr = cap.read()
        if not ok:
            break
        if i in wanted:
            out[i] = bgr
        i += 1
    cap.release()
    return out


def draw_strip(ref_video: Path, gen_video: Path, ref: dict, gen: dict, worst: list, signs: list, out_png: Path, tile: int = 240) -> None:
    import cv2
    if not worst:
        return
    rf = read_frames(ref_video, {w["frame"] for w in worst})
    gf = read_frames(gen_video, {w["gen_frame"] for w in worst if w["gen_frame"] >= 0})
    gloss_at = lambda i: next((s["gloss"] for s in signs if s["start"] <= i <= s["end"]), "")
    cols = []
    for w in worst:
        h = HANDS.index(w["hand"])
        sl = slice(468, 489) if h == 0 else slice(522, 543)
        pts_r = ref["x543"][w["frame"], sl, :2]
        pts_g = gen["x543"][w["gen_frame"], sl, :2] if w["gen_frame"] >= 0 else np.full((21, 2), np.nan)
        if np.isnan(pts_r).any() and np.isnan(pts_g).any():
            continue

        def box_of(pts, w, h):
            # square around the hand in pixels, as 0..1 coords of that video
            cx, cy = pts[:, 0].mean() * w, pts[:, 1].mean() * h
            half = max(np.ptp(pts[:, 0]) * w, np.ptp(pts[:, 1]) * h) * 0.9 + 0.04 * w
            return ((cx - half) / w, (cy - half) / h, (cx + half) / w, (cy + half) / h)

        # Each video is cropped around its own hand; a missing hand borrows the other video's box
        # (same framing for Recast; pose-driven models may frame differently).
        box_r = box_of(pts_r, ref["w"], ref["h"]) if not np.isnan(pts_r).any() else None
        box_g = box_of(pts_g, gen["w"], gen["h"]) if not np.isnan(pts_g).any() else None
        box_r, box_g = box_r or box_g, box_g or box_r
        tiles = []
        for img, pts, colour, box in ((rf.get(w["frame"]), pts_r, (80, 220, 80), box_r), (gf.get(w["gen_frame"]), pts_g, (60, 60, 240), box_g)):
            if img is None:
                tiles.append(np.zeros((tile, tile, 3), np.uint8))
                continue
            H, W = img.shape[:2]
            x0, y0, x1, y1 = [int(round(v)) for v in (box[0] * W, box[1] * H, box[2] * W, box[3] * H)]
            x1 = x0 + max(1, min(x1 - x0, y1 - y0)); y1 = y0 + (x1 - x0)
            pad = max(0, -x0, -y0, x1 - W, y1 - H)
            big = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(30, 30, 30))
            crop = big[y0 + pad:y1 + pad, x0 + pad:x1 + pad].copy()
            scale = tile / max(1, crop.shape[0])
            crop = cv2.resize(crop, (tile, tile), interpolation=cv2.INTER_AREA)
            if not np.isnan(pts).any():
                p = [(int((x * W - x0) * scale), int((y * H - y0) * scale)) for x, y in pts]
                for a, b in BONES:
                    cv2.line(crop, p[a], p[b], colour, 1, cv2.LINE_AA)
                for q in p:
                    cv2.circle(crop, q, 2, colour, -1, cv2.LINE_AA)
            tiles.append(crop)
        label = np.full((52, tile, 3), 255, np.uint8)
        g = gloss_at(w["frame"])
        cv2.putText(label, f"f{w['frame']} {w['hand'][0].upper()} {g}"[:26], (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1, cv2.LINE_AA)
        detail = "hand lost" if w["dropped"] else f"{w['score_deg']:.0f} deg"
        cv2.putText(label, f"{w['ref_shape'] or '-----'} > {w['gen_shape'] or '-----'}  {detail}", (4, 38), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 160), 1, cv2.LINE_AA)
        cols.append(np.vstack([tiles[0], tiles[1], label]))
    if cols:
        sep = np.full((cols[0].shape[0], 4, 3), 255, np.uint8)
        strip = np.hstack([c for col in cols for c in (col, sep)][:-1])
        out_png.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out_png), strip)


# ---------------------------------------------------------------- driver

def strip_private(c: dict) -> dict:
    return {k: v for k, v in c.items() if not k.startswith("_")}


def score_pair(ref_video: str, gen_video: str, out_dir: str, name: str | None = None, segments: str | None = None,
               motion: str | None = None, recognizer: str | None = None, worst_k: int = 8, max_shift: int = 0) -> dict:
    t0 = time.perf_counter()
    ref_video, gen_video, out = Path(ref_video), Path(gen_video), Path(out_dir)
    name = name or gen_video.parent.name or gen_video.stem
    model = model_path()
    ref, gen = landmarks(ref_video, model), landmarks(gen_video, model)
    segs = json.loads(Path(segments).read_text(encoding="utf-8")).get("segments") if segments else None
    mask, signs = sign_mask(len(ref["x543"]), segs)
    shift = best_shift(ref, gen, mask, max_shift)
    cmp = compare(ref, gen, mask, shift)
    worst = worst_frames(cmp, mask, worst_k)
    png = out / f"{name}-worst.png"
    draw_strip(ref_video, gen_video, ref, gen, worst, signs, png)
    report = {
        "schema_version": 1, "name": name, "ref": str(ref_video), "gen": str(gen_video),
        "segments_file": segments, "frames_ref": len(ref["x543"]), "frames_gen": len(gen["x543"]),
        "fps_ref": ref["fps"], "fps_gen": gen["fps"], "scope": "sign segments" if signs else "all frames",
        "frames_in_scope": int(mask.sum()), "gen_shift_frames": shift,
        "ref_vs_gen": strip_private(cmp), "per_sign": segment_scores(cmp, signs),
        "worst_frames": worst, "worst_png": str(png) if worst else None,
        "thresholds": {"ext_max_deg": EXT_MAX, "curl_min_deg": CURL_MIN},
    }
    mo = None
    if motion and Path(motion).exists():
        # The puppet is rendered from this motion at the same fps, so frame i of the motion is frame i of the puppet.
        mo = from_motion(motion)
        mm = np.zeros(len(mo["x543"]), bool)
        n = min(len(mm), len(mask))
        mm[:n] = mask[:n]
        mo["fps"] = ref["fps"]
        report["motion_file"] = motion
        report["motion_vs_ref"] = strip_private(compare(mo, ref, mm))["all"]
        report["motion_vs_gen"] = strip_private(compare(mo, gen, mm, shift))["all"]
    if recognizer and signs and recognizer_up(recognizer):
        report["recognizer"] = recognizer_scores(recognizer, ref, gen, cmp["_frame"]["idx"], signs, mo)
    report["seconds"] = round(time.perf_counter() - t0, 2)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{name}-finger.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    return report


def headline(r: dict) -> dict:
    a = r["ref_vs_gen"]["all"]
    row = {"name": r["name"], "frames": r["frames_ref"], "shift": r.get("gen_shift_frames", 0), "hand_frames": a["hand_frames_scored"],
           "joint_err": a["mean_joint_err_deg"], "p90": a["p90_joint_err_deg"], "shape_change": a["handshape_change_pct"],
           "drop": a["drop_pct"], "extra": a["extra_pct"], "index_flip": a["finger_flip_pct"]["index"]}
    if "motion_vs_ref" in r:
        row["puppet_err"] = r["motion_vs_ref"]["mean_joint_err_deg"]
        row["puppet_shape_change"] = r["motion_vs_ref"]["handshape_change_pct"]
        row["total_err"] = r["motion_vs_gen"]["mean_joint_err_deg"]
        row["total_shape_change"] = r["motion_vs_gen"]["handshape_change_pct"]
        row["total_drop"] = r["motion_vs_gen"]["drop_pct"]
    if "recognizer" in r:
        row["rec_motion_top1"] = r["recognizer"].get("motion_top1_pct")
        row["rec_ref_top1"] = r["recognizer"]["ref_top1_pct"]
        row["rec_gen_top1"] = r["recognizer"]["gen_top1_pct"]
        row["rec_agree"] = r["recognizer"]["agree_pct"]
    return row


def _prefetch(video: str) -> str:
    landmarks(Path(video))
    return video


def pooled(reports: list) -> dict:
    """Hand-frame-weighted means across pairs (each pair already summarises its own frames)."""
    def wmean(key, sub="ref_vs_gen", w="hand_frames_scored"):
        num = den = 0.0
        for r in reports:
            a = r[sub]["all"] if sub == "ref_vs_gen" else r.get(sub)
            if not a or a.get(key) is None:
                continue
            num += a[key] * a[w]
            den += a[w]
        return _r(num / den) if den else None

    def drop():
        num = den = 0.0
        for r in reports:
            a = r["ref_vs_gen"]["all"]
            if a["drop_pct"] is not None:
                num += a["drop_pct"] * a["ref_hand_frames"]
                den += a["ref_hand_frames"]
        return _r(num / den) if den else None

    out = {"pairs": len(reports), "hand_frames_scored": sum(r["ref_vs_gen"]["all"]["hand_frames_scored"] for r in reports),
           "mean_joint_err_deg": wmean("mean_joint_err_deg"), "mean_spread_err_deg": wmean("mean_spread_err_deg"),
           "handshape_change_pct": wmean("handshape_change_pct"), "drop_pct": drop()}
    out["index_flip_pct"] = _r(sum(r["ref_vs_gen"]["all"]["finger_flip_pct"]["index"] * r["ref_vs_gen"]["all"]["hand_frames_scored"]
                                  for r in reports if r["ref_vs_gen"]["all"]["finger_flip_pct"]["index"] is not None) / max(1, out["hand_frames_scored"]))
    mo = [r for r in reports if "motion_vs_ref" in r]
    if mo:
        out["motion_vs_ref_joint_err_deg"] = wmean("mean_joint_err_deg", "motion_vs_ref")
        out["motion_vs_ref_shape_change_pct"] = wmean("handshape_change_pct", "motion_vs_ref")
        out["motion_vs_gen_joint_err_deg"] = wmean("mean_joint_err_deg", "motion_vs_gen")
        out["motion_vs_gen_shape_change_pct"] = wmean("handshape_change_pct", "motion_vs_gen")
    rec = [r["recognizer"] for r in reports if "recognizer" in r]
    if rec:
        segs = [s for x in rec for s in x["segments"]]
        n = max(1, len(segs))
        out["recognizer"] = {"segments": len(segs), "agree_pct": _r(100 * sum(s["agree"] for s in segs) / n)}
        for k in ("motion", "ref", "gen"):
            have = [s for s in segs if f"{k}_hit" in s]
            if have:
                out["recognizer"][f"{k}_segments"] = len(have)
                out["recognizer"][f"{k}_top1_pct"] = _r(100 * sum(s[f"{k}_hit"] for s in have) / len(have))
                out["recognizer"][f"{k}_top5_pct"] = _r(100 * sum(s[f"{k}_top5"] for s in have) / len(have))
    return out


def batch(pairs_file: str, out_dir: str, workers: int, recognizer: str | None) -> dict:
    pairs = json.loads(Path(pairs_file).read_text(encoding="utf-8"))
    vids = sorted({p[k] for p in pairs for k in ("ref", "gen")})
    todo = [v for v in vids if not cache_key(Path(v)).exists()]
    if todo:
        print(f"tracking {len(todo)} videos with {workers} processes", flush=True)
        t = time.perf_counter()
        with ProcessPoolExecutor(workers) as ex:
            for n, _ in enumerate(ex.map(_prefetch, todo), 1):
                print(f"  {n}/{len(todo)} ({time.perf_counter() - t:.0f} s)", flush=True)
    rec = recognizer if recognizer and recognizer_up(recognizer) else None
    if recognizer and not rec:
        print(f"recognizer {recognizer} not reachable; skipping recognizer scores", flush=True)
    reports = []
    for p in pairs:
        r = score_pair(p["ref"], p["gen"], out_dir, p.get("name"), p.get("segments"), p.get("motion"), rec,
                       max_shift=int(p.get("max_shift", 0)))
        reports.append(r)
        print(json.dumps(headline(r)), flush=True)
    groups = {}
    for p, r in zip(pairs, reports):
        groups.setdefault(p.get("group", "all"), []).append(r)
    summary = {"schema_version": 1, "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "pooled": pooled(reports), "groups": {g: pooled(rs) for g, rs in groups.items()},
               "rows": [headline(r) for r in reports]}
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    (Path(out_dir) / "summary.json").write_text(json.dumps(summary, indent=1) + "\n", encoding="utf-8")
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pair")
    p.add_argument("--ref", required=True)
    p.add_argument("--gen", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--name")
    p.add_argument("--segments")
    p.add_argument("--motion")
    p.add_argument("--recognizer")
    p.add_argument("--worst", type=int, default=8)
    p.add_argument("--max-shift", type=int, default=0, help="search a generated-video frame offset up to this many frames")
    b = sub.add_parser("batch")
    b.add_argument("--pairs", required=True, help="JSON list of {name, ref, gen, segments?, motion?, group?}")
    b.add_argument("--out", required=True)
    b.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    b.add_argument("--recognizer")
    a = ap.parse_args(argv)
    if a.cmd == "pair":
        r = score_pair(a.ref, a.gen, a.out, a.name, a.segments, a.motion, a.recognizer, a.worst, a.max_shift)
        print(json.dumps({**headline(r), "report": str(Path(a.out) / f"{r['name']}-finger.json"), "worst_png": r["worst_png"]}))
    else:
        s = batch(a.pairs, a.out, a.workers, a.recognizer)
        print(json.dumps(s["pooled"], indent=1))


if __name__ == "__main__":
    sys.exit(main())
