"""Closed-vocabulary sign classifier with personal enrollment ("Train my signs"), fused with the GISLR prior.

Input is the legacy 543 x 3 layout (see recognizer.py). Only the hands and the pose are used for the personal
model (the face is never stored by enrollment). Pieces:

- features(x): per frame and per hand (dominant hand first, a left-handed signer is mirrored): wrist position in a
  shoulder frame, the 20 other hand points relative to the wrist / hand size, wrist velocity; resampled to L frames.
  Same idea as templates.py, so DTW templates and the classifier share one representation.
- Model: multinomial logistic regression on the flattened features (numpy, Adam, L2), trained on the generic WLASL
  demo clips + the person's own reps (weighted up) + a "none" class (other signs, transitions, idle hands). Each
  training clip is augmented (speed, trim, small rotation / scale / shift). Fits in about a second on a laptop CPU.
- DTW against the same clips (templates.dtw): d(label) = distance to that label's nearest template.
- Fusion: p(label) ~ p_lr(label)^A * g(label)^B * exp(-DTW_W * d(label)), with g = GISLR's probability for the labels
  it knows and an even share of its "everything else" mass for the ones it doesn't. Only the active vocabulary is
  ever returned.
- Open set: reject when "none" wins, the fused top-1 is below REJECT, or its DTW distance is far (DTW_FAR).

Landmarks are biometric: models store derived features only; enrollment stores pose + hands (no face).
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np

import templates as T

L = 24  # resampled frames per sign for the classifier (DTW uses the same sequence)
NONE = "_none"
# Demo vocabulary (finals). Label -> display text; GISLR label where it knows the same sign.
VOCAB = ["HELLO", "YES", "NO", "PLEASE", "THANK_YOU", "WATER", "HUNGRY", "SICK", "HOME", "HELP", "NAME", "NICE", "MEET",
         "YOU", "ME", "WHERE", "FINE", "HAPPY", "BYE", "SORRY"]
TEXT = {"THANK_YOU": "thank you", "ME": "me"}
GISLR_OF = {"HELLO": "hello", "YES": "yes", "NO": "no", "PLEASE": "please", "THANK_YOU": "thankyou", "WATER": "water",
            "HUNGRY": "hungry", "SICK": "sick", "HOME": "home", "WHERE": "where", "FINE": "fine", "HAPPY": "happy", "BYE": "bye"}
# Fusion and rejection (tuned leave-signer-out by eval_demo.py; see experiments/2026-11-16-sign-enrollment.md).
A, B, DTW_W = 1.0, 0.75, 2.0
REJECT = float(os.environ.get("PERSONAL_REJECT", "0.6"))
DTW_FAR = float(os.environ.get("PERSONAL_DTW_FAR", "1.0"))
OWN_WEIGHT = 3.0  # a person's own rep counts this many generic clips
AUG = 8  # augmented copies per training clip


def text_of(label: str) -> str:
    return TEXT.get(label, label.lower().replace("_", " "))


def strip_face(x: np.ndarray) -> np.ndarray:
    """Enrollment storage: hands + pose only (face points set to NaN)."""
    y = np.array(x, np.float32, copy=True)
    y[:, :468] = np.nan
    return y


# ── Features ──

def _med(a: np.ndarray):
    """Median over the frames where every value is finite (np.nanmedian is ~50x slower on small arrays); NaN if none."""
    ok = np.isfinite(a).all(-1) if a.ndim > 1 else np.isfinite(a)
    return np.median(a[ok], 0) if ok.any() else np.full(a.shape[1:], np.nan, np.float32)


def _body_frame(x: np.ndarray):
    pose = x[:, T.POSE:T.POSE + 33, :2]
    lsh, rsh, nose = pose[:, 11], pose[:, 12], pose[:, 0]
    mid = (lsh + rsh) / 2
    with np.errstate(all="ignore"):
        c = _med(mid)
        sx = float(_med(np.abs(lsh[:, 0] - rsh[:, 0])))
        sy = float(_med(mid[:, 1] - nose[:, 1]))
    if not np.all(np.isfinite(c)):
        c = np.nanmean(x[:, [T.LH, T.RH], :2].reshape(-1, 2), 0)
        if not np.all(np.isfinite(c)):
            c = np.array([0.5, 0.5], np.float32)
    if not np.isfinite(sx) or sx < 1e-3:
        sx = 0.25
    if not np.isfinite(sy) or sy < 1e-3:
        sy = sx * 0.55
    return c.astype(np.float32), np.array([sx, sy], np.float32)


def active_span(x: np.ndarray, body=None) -> tuple[int, int] | None:
    """First and last frame (inclusive) with a hand raised above the rest height (falls back to any hand seen)."""
    present = ~np.isnan(x[:, [T.LH, T.RH], :2]).any(-1)
    if not present.any():
        return None
    c, s = body or _body_frame(x)
    with np.errstate(invalid="ignore"):
        wy = (x[:, [T.LH, T.RH], 1] - c[1]) / s[1]
        active = (present & (wy < T.TRIM_Y)).any(1)
    if not active.any():
        active = present.any(1)
    idx = np.flatnonzero(active)
    return int(idx[0]), int(idx[-1])


def features(x: np.ndarray, n: int = L, mirror: bool | None = None) -> np.ndarray | None:
    """[frames, 543, 3] -> [n, 88] (2 hands x (wrist 2 + shape 40 + velocity 2)), dominant hand last; None without hands."""
    x = np.asarray(x, np.float32)
    if mirror is None:
        mirror = T.left_dominant(x)
    c, scale = _body_frame(x)
    span = active_span(x, (c, scale))
    if span is None:
        return None
    x = x[span[0]: span[1] + 1]
    present = ~np.isnan(x[:, [T.LH, T.RH], :2]).any(-1)
    blocks = []
    for h, start in enumerate((T.LH, T.RH)):
        p = (x[:, start:start + 21, :2] - c) / scale
        ok = present[:, h]
        if ok.sum() == 0:
            wrist = np.repeat(T.REST[h][None], len(p), 0)
            shape = np.zeros((len(p), 20, 2), np.float32)
        else:
            p = T._fill(np.nan_to_num(p), ok)
            wrist = p[:, 0]
            rel = p[:, 1:] - wrist[:, None]
            size = np.linalg.norm(rel[:, 8], axis=-1)
            size = np.where(size > 1e-4, size, np.median(size) + 1e-4)
            shape = rel / size[:, None, None]
        blocks.append((wrist, shape))
    if mirror:
        blocks = [(w * [-1, 1], s * [-1, 1]) for w, s in blocks[::-1]]
    out = []
    for h, (wrist, shape) in enumerate(blocks):
        w = T._resample(wrist, n)
        s = T._resample(shape, n)
        v = np.gradient(w, axis=0) * (n / 8)
        out.append(np.concatenate([w * T.W_POS, s.reshape(n, -1) * (T.W_SHAPE / np.sqrt(20)), v * T.W_VEL], 1) * T.W_HAND[h])
    return np.concatenate(out, 1).astype(np.float32)


def augment(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """A plausible other rep of the same sign: speed 0.8-1.25x, trim up to 12% each end, rotate +-8 deg, scale
    +-10%, shift +-5% (all around the shoulder midpoint)."""
    t = len(x)
    a = int(rng.uniform(0, 0.12) * t)
    b = t - int(rng.uniform(0, 0.12) * t)
    y = x[a:max(b, a + 2)]
    m = max(2, int(round(len(y) * rng.uniform(0.8, 1.25))))
    y = y[np.round(np.linspace(0, len(y) - 1, m)).astype(int)]  # nearest frame: keeps NaN (missing hands) as is
    c, _ = _body_frame(y)
    th = np.deg2rad(rng.uniform(-8, 8))
    k = rng.uniform(0.9, 1.1)
    R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]], np.float32) * k
    out = y.copy()
    out[..., :2] = (y[..., :2] - c) @ R.T + c + rng.uniform(-0.05, 0.05, 2).astype(np.float32)
    return out.astype(np.float32)


# ── Models ──

def dtw_dist(f: np.ndarray, bank: np.ndarray, band: int = 3) -> np.ndarray:
    return T.dtw(f, bank, band)


class LogReg:
    """Multinomial logistic regression: standardized inputs projected on their top PCS principal components (fast
    on CPU: ~1000 x 2112 -> 1000 x 128), L2, full-batch Adam. The projection is folded into W afterwards, so
    inference is one matrix product on the standardized features."""

    def __init__(self, l2: float = 1e-2, steps: int = 300, lr: float = 0.05, pcs: int = 128):
        self.l2, self.steps, self.lr, self.pcs = l2, steps, lr, pcs

    def fit(self, X: np.ndarray, y: np.ndarray, k: int, w: np.ndarray | None = None) -> "LogReg":
        X = X.astype(np.float32)
        self.mu = X.mean(0)
        self.sd = X.std(0) + 1e-3
        Z = (X - self.mu) / self.sd
        q = min(self.pcs, Z.shape[0] - 1, Z.shape[1])
        sv, vt = _top_pcs(Z, q)
        proj = (vt.T / (sv / np.sqrt(len(Z)) + 1e-3)).astype(np.float32)  # whitened components [d, q]
        Z = Z @ proj
        n, d = Z.shape
        w = np.ones(n, np.float32) if w is None else w.astype(np.float32)
        w = w / w.sum()
        Y = np.eye(k, dtype=np.float32)[y]
        W = np.zeros((d, k), np.float32)
        b = np.zeros(k, np.float32)
        m = [np.zeros_like(W), np.zeros_like(b)]
        v = [np.zeros_like(W), np.zeros_like(b)]
        for t in range(1, self.steps + 1):
            P = _softmax(Z @ W + b)
            G = (P - Y) * w[:, None]
            gW = Z.T @ G + self.l2 * W
            gb = G.sum(0)
            for i, (p, g) in enumerate(((W, gW), (b, gb))):
                m[i] = 0.9 * m[i] + 0.1 * g
                v[i] = 0.999 * v[i] + 0.001 * g * g
                p -= self.lr * (m[i] / (1 - 0.9 ** t)) / (np.sqrt(v[i] / (1 - 0.999 ** t)) + 1e-8)
        self.W, self.b = proj @ W, b
        return self

    def proba(self, X: np.ndarray) -> np.ndarray:
        return _softmax(((X - self.mu) / self.sd) @ self.W + self.b)


def _top_pcs(Z: np.ndarray, q: int, iters: int = 3) -> tuple[np.ndarray, np.ndarray]:
    """Top q singular values / right vectors of Z by randomized SVD (Halko et al.): a few matrix products and one
    small SVD, instead of a full LAPACK SVD that takes tens of seconds on a busy laptop."""
    rng = np.random.default_rng(0)
    Y = Z @ rng.standard_normal((Z.shape[1], q + 10)).astype(np.float32)
    for _ in range(iters):
        Y, _ = np.linalg.qr(Y)
        Y = Z @ (Z.T @ Y)
    Q, _ = np.linalg.qr(Y)
    _, s, vt = np.linalg.svd(Q.T @ Z, full_matrices=False)
    return s[:q], vt[:q]


def _softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(-1, keepdims=True)


def gislr_share(gislr_p: dict[str, float] | None, labels: list[str]) -> np.ndarray:
    """GISLR's view of each label: its probability where it knows the sign, an even share of the rest otherwise."""
    if not gislr_p:
        return np.full(len(labels), 1.0 / len(labels))
    known = [GISLR_OF.get(l) for l in labels]
    mass_known = sum(gislr_p.get(g, 0.0) for g in known if g)
    n_unknown = sum(1 for g in known if not g)
    other = max(0.0, 1.0 - mass_known) / max(1, n_unknown) if n_unknown else 0.0
    g = np.array([gislr_p.get(k, 0.0) if k else other for k in known], np.float64)
    return np.maximum(g, 1e-4)


def fuse(p_lr: np.ndarray, g: np.ndarray, d: np.ndarray | None = None, a: float = A, b: float = B, w: float = DTW_W) -> np.ndarray:
    s = a * np.log(np.maximum(p_lr, 1e-9)) + b * np.log(g)
    if d is not None:
        s = s - w * np.where(np.isfinite(d), d, 3.0)  # a label without templates counts as far
    s = np.exp(s - s.max())
    return s / s.sum()


# ── Training data ──

class Model:
    """A fitted closed-vocabulary model: labels (vocab + NONE), the LR, and DTW templates per label."""

    def __init__(self, labels, lr, bank, bank_idx, info):
        self.labels, self.lr, self.bank, self.bank_idx, self.info = labels, lr, bank, bank_idx, info

    def classify(self, x: np.ndarray, vocab: list[str] | None = None, gislr_p: dict[str, float] | None = None) -> dict:
        """-> {options: [{label, text, confidence}], reject, none, dtw}. Only labels in vocab (default: all trained)."""
        f = features(x)
        if f is None:
            return {"options": [], "reject": True, "none": 1.0, "dtw": None}
        p = self.lr.proba(f.reshape(1, -1))[0]
        labels = self.labels
        keep = [i for i, l in enumerate(labels) if l != NONE and (vocab is None or l in vocab)]
        none_p = float(p[labels.index(NONE)]) if NONE in labels else 0.0
        if not keep:
            return {"options": [], "reject": True, "none": none_p, "dtw": None}
        sub = p[keep] / max(p[keep].sum(), 1e-9)
        names = [labels[i] for i in keep]
        # DTW distance per label: its nearest template, both hand readings.
        dl = np.full(len(labels), np.inf)
        if len(self.bank):
            fm = features(x, mirror=not T.left_dominant(x))
            dd = dtw_dist(f, self.bank)
            if fm is not None:
                dd = np.minimum(dd, dtw_dist(fm, self.bank) + T.MIRROR_PENALTY)
            np.minimum.at(dl, self.bank_idx, dd)
        dk = dl[keep]
        fused = fuse(sub, gislr_share(gislr_p, names), dk if len(self.bank) else None)
        top = int(np.argmax(fused))
        d = float(dk[top]) if np.isfinite(dk[top]) else None
        order = np.argsort(-fused)[:5]
        options = [{"label": names[i], "text": text_of(names[i]), "confidence": round(float(fused[i]), 4)} for i in order]
        best_none = none_p > p[keep].max()
        reject = bool(best_none or fused[top] < REJECT or (d is not None and d > DTW_FAR))
        return {"options": options, "reject": reject, "none": round(none_p, 4), "dtw": None if d is None else round(d, 4)}


def build_training(clips: list[tuple[np.ndarray, str, float]], negatives: list[np.ndarray], labels: list[str],
                   aug: int = AUG, seed: int = 0, extra: dict | None = None):
    """clips: (frames, label, weight). negatives: frames (or features) for the NONE class. extra: generic features
    already computed {X: [n, L, 88], labels: [n], orig: [n] (True = not augmented, also a DTW template)}, weight 1.
    -> X, y, w, bank feats, bank label idx."""
    rng = np.random.default_rng(seed)
    X, y, w, bank, bidx = [], [], [], [], []
    li = {l: i for i, l in enumerate(labels)}
    if extra is not None:
        for f, label, orig in zip(extra["X"], extra["labels"], extra["orig"]):
            if label not in li:
                continue
            X.append(f.reshape(-1)); y.append(li[label]); w.append(1.0)
            if orig:
                bank.append(f); bidx.append(li[label])
    for x, label, weight in clips:
        f = features(x)
        if f is None:
            continue
        bank.append(f)
        bidx.append(li[label])
        X.append(f.reshape(-1)); y.append(li[label]); w.append(weight)
        for _ in range(aug):
            fa = features(augment(x, rng))
            if fa is not None:
                X.append(fa.reshape(-1)); y.append(li[label]); w.append(weight)
    if NONE in li:
        for x in negatives:  # frames, or features already computed ([L, 88])
            f = x if x.ndim == 2 and x.shape[0] == L else features(x)
            if f is not None:
                X.append(f.reshape(-1)); y.append(li[NONE]); w.append(1.0)
    return (np.array(X, np.float32), np.array(y), np.array(w, np.float32), np.array(bank, np.float32), np.array(bidx))


def train(clips, negatives, labels: list[str] | None = None, aug: int = AUG, l2: float = 1e-2, steps: int = 300, seed: int = 0,
          extra: dict | None = None) -> Model:
    t = time.perf_counter()
    labels = labels or sorted({l for _, l, _ in clips}) + ([NONE] if negatives else [])
    X, y, w, bank, bidx = build_training(clips, negatives, labels, aug, seed, extra)
    # Balance: every class gets the same total weight (the none class is large).
    for k in range(len(labels)):
        s = w[y == k].sum()
        if s > 0:
            w[y == k] /= s
    lr = LogReg(l2=l2, steps=steps).fit(X, y, len(labels), w)
    info = {"labels": labels, "samples": int(len(X)), "train_ms": round((time.perf_counter() - t) * 1000)}
    return Model(labels, lr, bank, bidx, info)


def save(model: Model, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.npz")
    np.savez_compressed(tmp, labels=np.array(model.labels), W=model.lr.W, b=model.lr.b, mu=model.lr.mu, sd=model.lr.sd,
                        bank=model.bank.astype(np.float16), bank_idx=model.bank_idx, info=json.dumps(model.info))
    os.replace(tmp, path)


def load(path: Path) -> Model:
    z = np.load(path, allow_pickle=False)
    lr = LogReg()
    lr.W, lr.b, lr.mu, lr.sd = z["W"], z["b"], z["mu"], z["sd"]
    return Model([str(s) for s in z["labels"]], lr, z["bank"].astype(np.float32), z["bank_idx"], json.loads(str(z["info"])))


# ── Long segments: split into the signs that explain them best ──

SPLIT_MS = 1500  # segments longer than this are tried as 2+ signs
SIGN_MS = (300, 2200)  # one sign's length range for the decoder
SIGN_COST = 0.7  # log-penalty per extra sign (prefers fewer, longer signs unless they are clearly better)


def decode(model: Model, x: np.ndarray, fps: float, vocab: list[str] | None = None) -> list[tuple[int, int]]:
    """Pieces of one segment, [(start, end), ...], maximizing the sum of log p(best label) minus SIGN_COST per extra
    sign, cut only at speed valleys (segment.valleys). Personal classifier only (fast); the caller reads each piece."""
    import segment as S

    n = len(x)
    if n * 1000 / fps < SPLIT_MS:
        return [(0, n)]
    cand = [0] + S.valleys(x, fps) + [n]
    if len(cand) == 2:
        return [(0, n)]
    lo, hi = (int(round(m * fps / 1000)) for m in SIGN_MS)
    keep = [i for i, l in enumerate(model.labels) if l != NONE and (vocab is None or l in vocab)]

    def score(a: int, b: int) -> float:
        f = features(x[a:b])
        if f is None:
            return -9.0
        p = model.lr.proba(f.reshape(1, -1))[0]
        return float(np.log(max(p[keep].max(), 1e-6)))

    best = [(-np.inf, -1)] * len(cand)
    best[0] = (0.0, -1)
    last = len(cand) - 1
    for j in range(1, len(cand)):
        for i in range(j):
            ln = cand[j] - cand[i]
            if best[i][0] == -np.inf or (not lo <= ln <= hi and not (i == 0 and j == last)):
                continue
            s = best[i][0] + score(cand[i], cand[j]) - (SIGN_COST if i > 0 else 0.0)
            if s > best[j][0]:
                best[j] = (s, i)
    if best[last][1] < 0:
        return [(0, n)]
    out, j = [], last
    while j > 0:
        i = best[j][1]
        out.append((cand[i], cand[j]))
        j = i
    return out[::-1]
