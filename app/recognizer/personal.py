"""Closed-vocabulary sign classifier with personal enrollment ("Train my signs"), fused with the GISLR prior.

Input is the legacy 543 x 3 layout (see recognizer.py). Only the hands and the pose are used for the personal
model (the face is never stored by enrollment). Pieces:

- features(x): per frame and per hand (dominant hand first, a left-handed signer is mirrored): wrist position in a
  shoulder frame, the 20 other hand points relative to the wrist / hand size, wrist velocity; resampled to L frames.
  Same idea as templates.py, so DTW templates and the classifier share one representation.
- Model: multinomial logistic regression on the flattened features (numpy, Adam, L2), trained on the generic WLASL
  demo clips + the person's own reps (weighted up) + a "none" class (other signs, transitions, idle hands).
  Augmenting the clips (speed, trim, rotation / scale / shift: augment(), AUG) measured worse, so it is off.
  Fits in a few seconds on a laptop CPU.
- DTW against the same clips (templates.dtw): d(label) = distance to that label's nearest template.
- Fusion: p(label) ~ p_lr(label)^A * g(label)^B * exp(-DTW_W * d(label)), with g = GISLR's probability for the labels
  it knows and an even share of its "everything else" mass for the ones it doesn't. Only the active vocabulary is
  ever returned.
- Open set: reject ("no sign") when the none class wins; unsure when the fused top-1 is below REJECT or its DTW
  distance is far (DTW_FAR): kept, with a "not sure" hint in the app.

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
# Fusion and rejection (tuned leave-signer-out by eval/eval_demo.py; see experiments/2026-11-16-sign-enrollment.md).
A, B, DTW_W = 1.0, 0.75, 2.0
REJECT = float(os.environ.get("PERSONAL_REJECT", "0.6"))
DTW_FAR = float(os.environ.get("PERSONAL_DTW_FAR", "1.0"))
OWN_WEIGHT = 3.0  # a person's own rep counts this many generic clips
AUG = 0  # augmented copies per training clip (leave-signer-out: 0 beat 8, 86% vs 83% top-1; augment() stays for tests)
# Signer-invariance options of features() (eval/eval_generic.py measures each leave-signer-out; a model stores the ones it
# was trained with in info["feat"], so old models keep reading the old way):
#   rot:    rotate every frame so the shoulder line is level (head / camera tilt), scale by the full shoulder distance
#   arclen: resample by the dominant hand's path length (+ ARC_T of time) instead of time: speed normalisation
FEAT: dict = {"rot": False, "arclen": False}
ARC_T = 0.3  # share of the resampling "clock" that is plain time (holds do not vanish completely)
# Open-set rejection: reject ("no sign") when log(p_lr(best sign)) - log(p_lr(none)) - REJ_DTW * DTW(best) < REJ_T.
# REJ_DTW = REJ_T = 0 is the old rule (the none class wins).
REJ_DTW = float(os.environ.get("PERSONAL_REJ_DTW", "0"))
REJ_T = float(os.environ.get("PERSONAL_REJ_T", "0"))


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


def _shoulder_angle(x: np.ndarray) -> float:
    """Median angle of the shoulder line (subject's right -> left shoulder, image coords), 0 when level / unknown."""
    pose = x[:, T.POSE:T.POSE + 33, :2]
    v = pose[:, 11] - pose[:, 12]
    with np.errstate(all="ignore"):
        a = _med(np.arctan2(v[:, 1], v[:, 0]))
    a = float(a) if np.ndim(a) == 0 else float("nan")
    return a if np.isfinite(a) and abs(a) < 0.6 else 0.0


def _rotate(x: np.ndarray, a: float) -> np.ndarray:
    """Rotate x / y of every point by -a around the shoulder midpoint (levels the shoulder line)."""
    if abs(a) < 1e-4:
        return x
    pose = x[:, T.POSE:T.POSE + 33, :2]
    with np.errstate(all="ignore"):
        c = _med((pose[:, 11] + pose[:, 12]) / 2)
    if not np.all(np.isfinite(c)):
        return x
    ca, sa = np.cos(-a), np.sin(-a)
    R = np.array([[ca, -sa], [sa, ca]], np.float32)
    y = x.copy()
    y[..., :2] = (x[..., :2] - c) @ R.T + c
    return y


def _body_frame(x: np.ndarray, full: bool = False):
    pose = x[:, T.POSE:T.POSE + 33, :2]
    lsh, rsh, nose = pose[:, 11], pose[:, 12], pose[:, 0]
    mid = (lsh + rsh) / 2
    with np.errstate(all="ignore"):
        c = _med(mid)
        sx = float(_med(np.linalg.norm(lsh - rsh, axis=-1) if full else np.abs(lsh[:, 0] - rsh[:, 0])))
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


def _resample_at(a: np.ndarray, src: np.ndarray) -> np.ndarray:
    i0 = np.clip(np.floor(src).astype(int), 0, len(a) - 1)
    i1 = np.minimum(i0 + 1, len(a) - 1)
    w = (src - i0).reshape(-1, *([1] * (a.ndim - 1)))
    return a[i0] * (1 - w) + a[i1] * w


def features(x: np.ndarray, n: int = L, mirror: bool | None = None, cfg: dict | None = None) -> np.ndarray | None:
    """[frames, 543, 3] -> [n, 88] (2 hands x (wrist 2 + shape 40 + velocity 2)), dominant hand last; None without hands.
    cfg: signer-invariance options (FEAT keys), default FEAT."""
    cfg = {**FEAT, **(cfg or {})}
    x = np.asarray(x, np.float32)
    if mirror is None:
        mirror = T.left_dominant(x)
    if cfg.get("rot"):
        x = _rotate(x, _shoulder_angle(x))
    c, scale = _body_frame(x, full=bool(cfg.get("rot")))
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
    src = None
    if cfg.get("arclen") and len(blocks[1][0]) > 2:
        step = np.linalg.norm(np.diff(blocks[1][0], axis=0), axis=-1)  # dominant wrist (last block)
        tot = step.sum()
        if tot > 1e-3:
            clock = np.concatenate([[0.0], np.cumsum((1 - ARC_T) * step / tot + ARC_T / len(step))])
            src = np.interp(np.linspace(0, clock[-1], n), clock, np.arange(len(clock)))
    out = []
    for h, (wrist, shape) in enumerate(blocks):
        w = T._resample(wrist, n) if src is None else _resample_at(wrist, src)
        s = T._resample(shape, n) if src is None else _resample_at(shape, src)
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
        self.feat = {"rot": False, "arclen": False, **info.get("feat", {})}  # models without it: the original features
        self.rej = info.get("reject", {"dtw": REJ_DTW, "t": REJ_T})

    def classify(self, x: np.ndarray, vocab: list[str] | None = None, gislr_p: dict[str, float] | None = None) -> dict:
        """-> {options: [{label, text, confidence}], reject, none, dtw}. Only labels in vocab (default: all trained)."""
        f = features(x, cfg=self.feat)
        if f is None:
            return {"options": [], "reject": True, "unsure": True, "none": 1.0, "dtw": None, "margin": -9.0}
        p = self.lr.proba(f.reshape(1, -1))[0]
        labels = self.labels
        keep = [i for i, l in enumerate(labels) if l != NONE and (vocab is None or l in vocab)]
        none_p = float(p[labels.index(NONE)]) if NONE in labels else 0.0
        if not keep:
            return {"options": [], "reject": True, "unsure": True, "none": none_p, "dtw": None, "margin": -9.0}
        sub = p[keep] / max(p[keep].sum(), 1e-9)
        names = [labels[i] for i in keep]
        # DTW distance per label: its nearest template, both hand readings.
        dl = np.full(len(labels), np.inf)
        if len(self.bank):
            fm = features(x, mirror=not T.left_dominant(x), cfg=self.feat)
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
        # reject = "no sign" (the none class wins: a transition, fidgeting, another sign). Merely unsure (low fused
        # confidence or far from every template) is kept with unsure: true: on continuous signing, dropping those
        # lost more right words than wrong ones (eval/eval_demo.py continuous).
        # margin: how much more the LR believes the best sign than "no sign", minus a DTW penalty (calibrated
        # leave-signer-out against other WLASL signs, eval/eval_generic.py); the old rule is margin < 0 with no penalty.
        margin = float(np.log(max(p[keep].max(), 1e-9)) - np.log(max(none_p, 1e-9)) - self.rej["dtw"] * (d if d is not None else 3.0))
        reject = bool(margin < self.rej["t"])
        unsure = bool(fused[top] < REJECT or (d is not None and d > DTW_FAR))
        return {"options": options, "reject": reject, "unsure": unsure, "none": round(none_p, 4), "dtw": None if d is None else round(d, 4),
                "margin": round(margin, 4)}


def build_training(clips: list[tuple[np.ndarray, str, float]], negatives: list[np.ndarray], labels: list[str],
                   aug: int = AUG, seed: int = 0, extra: dict | None = None, feat: dict | None = None):
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
        f = features(x, cfg=feat)
        if f is None:
            continue
        bank.append(f)
        bidx.append(li[label])
        X.append(f.reshape(-1)); y.append(li[label]); w.append(weight)
        for _ in range(aug):
            fa = features(augment(x, rng), cfg=feat)
            if fa is not None:
                X.append(fa.reshape(-1)); y.append(li[label]); w.append(weight)
    if NONE in li:
        for x in negatives:  # frames, or features already computed ([L, 88])
            f = x if x.ndim == 2 and x.shape[0] == L else features(x, cfg=feat)
            if f is not None:
                X.append(f.reshape(-1)); y.append(li[NONE]); w.append(1.0)
    return (np.array(X, np.float32), np.array(y), np.array(w, np.float32), np.array(bank, np.float32), np.array(bidx))


def train(clips, negatives, labels: list[str] | None = None, aug: int = AUG, l2: float = 1e-2, steps: int = 300, seed: int = 0,
          extra: dict | None = None, feat: dict | None = None, reject: dict | None = None, none_w: float = 1.0) -> Model:
    """feat: features() options (default FEAT; must match extra's features). reject: {dtw, t} (default REJ_*).
    none_w: total weight of the none class relative to one sign's."""
    t = time.perf_counter()
    feat = {**FEAT, **(feat or (extra or {}).get("feat") or {})}
    labels = labels or sorted({l for _, l, _ in clips}) + ([NONE] if negatives else [])
    X, y, w, bank, bidx = build_training(clips, negatives, labels, aug, seed, extra, feat)
    # Balance: every class gets the same total weight (the none class is large), the none class none_w times that.
    for k in range(len(labels)):
        s = w[y == k].sum()
        if s > 0:
            w[y == k] /= s / (none_w if labels[k] == NONE else 1.0)
    lr = LogReg(l2=l2, steps=steps).fit(X, y, len(labels), w)
    info = {"labels": labels, "samples": int(len(X)), "train_ms": round((time.perf_counter() - t) * 1000), "feat": feat,
            "reject": reject or {"dtw": REJ_DTW, "t": REJ_T}}
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
        f = features(x[a:b], cfg=model.feat)
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
