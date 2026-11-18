"""Template-matching sign recognizer (no training): nearest WLASL motion template by banded DTW.

Covers the words GISLR (250 kid-vocabulary labels) lacks, e.g. HOW, GOOD, EVENING, COMPANY, JUDGE, COFFEE.
The bank (models/templates.npz, built by eval/build_templates.py from the extracted WLASL raw motion) holds one or
more templates per gloss as fixed-length feature sequences. Input is the same legacy 543 x 3 layout the server
receives (face 0-467 | left hand 468-488 | pose 489-521 | right hand 522-542, image coords, NaN = missing).

Features per frame (shoulder frame: origin = shoulder midpoint, x / shoulder width, y / neck height, so the
image aspect ratio and signer distance cancel out), per hand:
  wrist position (2), 20 hand points relative to the wrist / hand size (40), wrist velocity (2).
Templates are stored right-dominant (left-handed signers mirrored); a query is mirrored when it looks left-handed
(left_dominant), and also matched the other way round with a small penalty. Frames with both hands at rest
(below TRIM_Y) at the start and end are trimmed.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

L = 32  # resampled frames per sequence
BAND = 4  # Sakoe-Chiba band (frames) for DTW
MIRROR_PENALTY = 0.15  # added to the distance of the query read with the other hand as dominant
TRIM_Y = 2.0  # wrist below this (neck heights under the shoulders) = hands at rest, trimmed
LH, RH, POSE = 468, 522, 489
# Block weights (per frame). Dominant (right) hand counts more than the other one.
W_POS, W_SHAPE, W_VEL = 1.0, 0.6, 1.5
W_HAND = (0.6, 1.0)  # (left, right) after canonicalising to right-dominant
REST = np.array([[0.9, 3.0], [-0.9, 3.0]], np.float32)  # absent hand: below each shoulder (subject left, right)
BANK_PATH = Path(os.environ.get("RECOGNIZER_MODELS") or Path(__file__).resolve().parent / "models") / "templates.npz"

# Calibration of distance -> pseudo-confidence (eval/build_templates.py --eval): the margin to the next glosses is what
# separates right from wrong (leave-one-out: best-vs-second margin > 0.08 was right 11/11), the absolute distance
# much less so. So: softmax over the 5 nearest glosses (temperature TAU), times a gate on the best distance that
# only kills segments far from every template (not a sign we know / no real signing).
TAU = 0.06
D0, DW = 0.9, 0.1  # gate: sigmoid((D0 - d_best) / DW)
# GISLR's softmax is overconfident on signs outside its 250 labels (WLASL check: TIRED -> "animal" 0.88), so its
# confidence is scaled by this before the two lists are merged; a confident template (margin ~0.1 -> ~0.75)
# then beats a middling GISLR guess, and a sure GISLR read (>= 0.9) still beats a weak template.
GISLR_WEIGHT = 0.8

# Gloss -> display text where the plain lowercase gloss is wrong.
TEXT = {"I": "I", "ME": "me", "A LOT": "a lot"}


def gloss_label(gloss: str) -> str:
    """'THANK YOU' -> 'THANK_YOU' (labelText in app/core turns it back into 'thank you')."""
    return gloss.upper().replace(" ", "_")


def gloss_text(gloss: str) -> str:
    g = gloss.upper().replace("_", " ")
    return TEXT.get(g, g.lower())


def raw_to_frames(raw: dict) -> np.ndarray:
    """A motion raw.json (FORMAT v1, MediaPipe holistic, image coords) -> float32 [frames, 543, 3] like the web sends."""
    out = np.full((len(raw["frames"]), 543, 3), np.nan, np.float32)
    for i, f in enumerate(raw["frames"]):
        for key, start, n in (("face", 0, 468), ("leftHand", LH, 21), ("pose", POSE, 33), ("rightHand", RH, 21)):
            pts = f.get(key)
            if pts:
                a = np.asarray(pts, np.float32)[:n, :3]
                out[i, start:start + len(a)] = a
    return out


def _fill(a: np.ndarray, ok: np.ndarray) -> np.ndarray:
    """Linear interpolation over time of rows where ok is False ([T, ...] array, ok [T])."""
    if ok.all():
        return a
    t = np.arange(len(a))
    flat = a.reshape(len(a), -1)
    out = np.empty_like(flat)
    for k in range(flat.shape[1]):
        out[:, k] = np.interp(t, t[ok], flat[ok, k])
    return out.reshape(a.shape)


def _resample(a: np.ndarray, n: int = L) -> np.ndarray:
    if len(a) == 1:
        return np.repeat(a, n, 0)
    src = np.linspace(0, len(a) - 1, n)
    i0 = np.floor(src).astype(int)
    i1 = np.minimum(i0 + 1, len(a) - 1)
    w = (src - i0).reshape(-1, *([1] * (a.ndim - 1)))
    return a[i0] * (1 - w) + a[i1] * w


def left_dominant(x: np.ndarray) -> bool:
    """Guess the signer's dominant hand: the one that is raised (above TRIM_Y) more and moves more."""
    x = np.asarray(x, np.float32)
    score = []
    for start in (LH, RH):
        w = x[:, start, :2]
        ok = np.isfinite(w).all(1)
        if ok.sum() < 2:
            score.append(0.0)
            continue
        path = np.linalg.norm(np.diff(w[ok], axis=0), axis=1).sum()
        score.append(ok.sum() / len(w) + 4 * path)
    return score[0] > score[1]


def features(x: np.ndarray, mirror: bool | None = False) -> np.ndarray | None:
    """[frames, 543, 3] -> weighted feature sequence [L, D] (D = 2 hands x 44), or None without any hand.

    mirror=None mirrors when the signer looks left-handed (left_dominant), so the dominant hand is always "right".
    """
    x = np.asarray(x, np.float32)
    if mirror is None:
        mirror = left_dominant(x)
    present = ~np.isnan(x[:, [LH, RH], :2]).any(-1)  # [T, 2]
    if not present.any():
        return None
    pose = x[:, POSE:POSE + 33, :2]
    lsh, rsh, nose = pose[:, 11], pose[:, 12], pose[:, 0]
    mid = (lsh + rsh) / 2
    with np.errstate(all="ignore"):
        c = np.nanmedian(mid, 0)
        sx = np.nanmedian(np.abs(lsh[:, 0] - rsh[:, 0]))
        sy = np.nanmedian(mid[:, 1] - nose[:, 1])
    if not np.all(np.isfinite(c)):  # no pose: centre on the hands
        c = np.nanmean(x[:, [LH, RH], :2].reshape(-1, 2), 0)
    if not np.isfinite(sx) or sx < 1e-3:
        sx = 0.25
    if not np.isfinite(sy) or sy < 1e-3:
        sy = sx * 0.55
    scale = np.array([sx, sy], np.float32)
    # Signing span: frames with a hand raised above the resting height (falls back to any hand visible).
    with np.errstate(invalid="ignore"):
        wy = (x[:, [LH, RH], 1] - c[1]) / sy
        active = (present & (wy < TRIM_Y)).any(1)
    if not active.any():
        active = present.any(1)
    idx = np.flatnonzero(active)
    x = x[idx[0]: idx[-1] + 1]
    present = present[idx[0]: idx[-1] + 1]

    blocks = []
    for h, start in enumerate((LH, RH)):
        p = (x[:, start:start + 21, :2] - c) / scale  # [T, 21, 2] shoulder frame
        ok = present[:, h]
        if ok.sum() == 0:
            wrist = np.repeat(REST[h][None], len(p), 0)
            shape = np.zeros((len(p), 20, 2), np.float32)
        else:
            p = _fill(np.nan_to_num(p), ok)
            wrist = p[:, 0]
            rel = p[:, 1:] - wrist[:, None]
            size = np.linalg.norm(rel[:, 8], axis=-1)  # wrist -> middle finger MCP (point 9)
            size = np.where(size > 1e-4, size, np.median(size) + 1e-4)
            shape = rel / size[:, None, None]
        blocks.append((wrist, shape))

    def seq(blks):
        frames = []
        for h, (wrist, shape) in enumerate(blks):
            w = _resample(wrist)
            s = _resample(shape)
            v = np.gradient(w, axis=0) * (L / 8)
            frames.append(np.concatenate([w * W_POS, s.reshape(L, -1) * (W_SHAPE / np.sqrt(20)), v * W_VEL], 1) * W_HAND[h])
        return np.concatenate(frames, 1).astype(np.float32)

    if mirror:  # subject's left <-> right, x negated
        blocks = [(w * [-1, 1], s * [-1, 1]) for w, s in blocks[::-1]]
    return seq(blocks)


def dtw(q: np.ndarray, bank: np.ndarray, band: int | None = None) -> np.ndarray:
    """Banded DTW of one query [L, D] against [M, L, D] templates -> [M] mean per-step euclidean cost."""
    band = BAND if band is None else band
    qq = (q * q).sum(-1)  # [L]
    tt = (bank * bank).sum(-1)  # [M, L]
    cost = np.sqrt(np.maximum(qq[:, None, None] + tt.T[None] - 2 * np.einsum("id,mjd->ijm", q, bank), 0))  # [L, L, M]
    n = q.shape[0]
    acc = np.full((n + 1, n + 1, bank.shape[0]), np.inf, np.float32)
    acc[0, 0] = 0
    for i in range(1, n + 1):
        for j in range(max(1, i - band), min(n, i + band) + 1):
            acc[i, j] = cost[i - 1, j - 1] + np.minimum(np.minimum(acc[i - 1, j], acc[i, j - 1]), acc[i - 1, j - 1])
    return acc[n, n] / (2 * n)


class TemplateBank:
    def __init__(self, path: Path = BANK_PATH):
        z = np.load(path, allow_pickle=False)
        self.glosses = [str(g) for g in z["glosses"]]  # unique glosses
        self.gloss_idx = z["gloss_idx"]  # [M] template -> gloss
        self.stems = [str(s) for s in z["stems"]]
        self.feats = z["feats"].astype(np.float32)  # [M, L, D]

    def __len__(self):
        return len(self.glosses)

    def distances(self, x: np.ndarray, exclude: set[str] | None = None) -> np.ndarray | None:
        """Best DTW distance per gloss [G] (min over that gloss's templates and both hand readings), or None without hands."""
        left = left_dominant(x)
        f, fm = features(x, mirror=left), features(x, mirror=not left)
        if f is None:
            return None
        d = np.minimum(dtw(f, self.feats), dtw(fm, self.feats) + MIRROR_PENALTY)
        if exclude:
            d = np.where([s in exclude for s in self.stems], np.inf, d)
        best = np.full(len(self.glosses), np.inf, np.float32)
        np.minimum.at(best, self.gloss_idx, d)
        return best

    def match(self, x: np.ndarray, top: int = 5, exclude: set[str] | None = None) -> list[dict]:
        d = self.distances(x, exclude)
        if d is None:
            return []
        return scores_to_options(d, self.glosses, top)


def scores_to_options(d: np.ndarray, glosses: list[str], top: int = 5) -> list[dict]:
    order = [i for i in np.argsort(d)[:top] if np.isfinite(d[i])]
    if not order:
        return []
    dk = d[order].astype(np.float64)
    p = np.exp(-(dk - dk[0]) / TAU)
    p /= p.sum()
    conf = p / (1 + np.exp(-(D0 - dk[0]) / DW))
    return [{"label": gloss_label(glosses[i]), "text": gloss_text(glosses[i]), "confidence": round(float(c), 4),
             "distance": round(float(d[i]), 4)} for i, c in zip(order, conf)]


def merge(gislr: list[dict], tmpl: list[dict], top: int = 5, gislr_weight: float | None = None) -> list[dict]:
    """One top-N from both recognizers, keyed by display text; a sign both know gets the noisy-or of the two."""
    w = GISLR_WEIGHT if gislr_weight is None else gislr_weight
    by_text: dict[str, dict] = {}
    for o in gislr:
        by_text[o["text"].lower()] = {**o, "confidence": round(o["confidence"] * w, 4)}
    for o in tmpl:
        k = o["text"].lower()
        if k in by_text:
            a = by_text[k]["confidence"]
            by_text[k]["confidence"] = round(1 - (1 - a) * (1 - o["confidence"]), 4)
        else:
            by_text[k] = {"label": o["label"], "text": o["text"], "confidence": o["confidence"]}
    return sorted(by_text.values(), key=lambda o: -o["confidence"])[:top]
