"""Train my signs: enrollment storage, training and per-profile models for personal.py.

Storage (gitignored, local only, ENROLL_DIR, default <repo>/out/enroll):
    <profile>/<LABEL>/<timestamp>.npy   one rep, float16 [frames, 543, 3] with the FACE REMOVED (hands + pose only)
    <profile>/model.npz                 the fitted model (derived features only)
Generic data (models/demo_generic.npz, built by build_demo_model.py from WLASL clips of the demo signs): features
of the generic reps (augmented) and of the none class, so a profile with few reps still knows every demo sign, and
models/demo_model.npz = the generic model alone (profile "demo", used before anyone enrolls).
"""

from __future__ import annotations

import os
import re
import shutil
import threading
import time
from pathlib import Path

import numpy as np

import personal as P

HERE = Path(__file__).resolve().parent
ENROLL_DIR = Path(os.environ.get("ENROLL_DIR") or HERE.parents[1] / "out" / "enroll")
MODELS = Path(os.environ.get("RECOGNIZER_MODELS") or HERE / "models")
GENERIC = MODELS / "demo_generic.npz"
DEFAULT_MODEL = MODELS / "demo_model.npz"
PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
LABELS = set(P.VOCAB) | {P.NONE}
MAX_REPS = 20  # per label and profile


class EnrollError(ValueError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


def check_profile(p: str | None) -> str:
    p = (p or "").strip().lower()
    if not PROFILE_RE.match(p):
        raise EnrollError(400, "bad_profile", "profile: 1-32 of a-z 0-9 _ -, starting with a letter or digit")
    return p


def check_label(label: str | None) -> str:
    l = (label or "").strip()
    l = P.NONE if l.lower() == P.NONE else l.upper()
    if l not in LABELS:
        raise EnrollError(400, "bad_label", f"label must be one of {sorted(LABELS)}")
    return l


class Store:
    def __init__(self, root: Path = ENROLL_DIR):
        self.root = Path(root)
        self._models: dict[str, tuple[float, P.Model]] = {}
        self._lock = threading.Lock()
        self._default: P.Model | None = None
        self._default_tried = False

    # ── reps ──
    def add(self, profile: str, label: str, x: np.ndarray) -> dict:
        profile, label = check_profile(profile), check_label(label)
        if P.features(x) is None:
            raise EnrollError(422, "no_hands", "no hands in this recording: sign again with your hands in view")
        d = self.root / profile / label
        d.mkdir(parents=True, exist_ok=True)
        reps = sorted(d.glob("*.npy"))
        for old in reps[: max(0, len(reps) - MAX_REPS + 1)]:
            old.unlink()
        np.save(d / f"{int(time.time() * 1000)}.npy", P.strip_face(x).astype(np.float16))
        return self.info(profile)

    def reps(self, profile: str) -> dict[str, list[Path]]:
        d = self.root / check_profile(profile)
        if not d.exists():
            return {}
        return {p.name: sorted(p.glob("*.npy")) for p in sorted(d.iterdir()) if p.is_dir() and p.name in LABELS}

    def info(self, profile: str) -> dict:
        profile = check_profile(profile)
        m = self.root / profile / "model.npz"
        out = {"profile": profile, "reps": {k: len(v) for k, v in self.reps(profile).items() if v}, "trained": m.exists()}
        if m.exists():
            out["model"] = self.model(profile).info
        return out

    def delete(self, profile: str, label: str | None = None) -> dict:
        profile = check_profile(profile)
        d = self.root / profile
        if label:
            shutil.rmtree(d / check_label(label), ignore_errors=True)
            (d / "model.npz").unlink(missing_ok=True)
        else:
            shutil.rmtree(d, ignore_errors=True)
        with self._lock:
            self._models.pop(profile, None)
        return {"profile": profile, "deleted": label or "all"}

    def profiles(self) -> list[str]:
        if not self.root.exists():
            return []
        return sorted(p.name for p in self.root.iterdir() if p.is_dir() and PROFILE_RE.match(p.name))

    # ── training ──
    def train(self, profile: str) -> dict:
        profile = check_profile(profile)
        t = time.perf_counter()
        own = [(np.load(f).astype(np.float32), label, P.OWN_WEIGHT) for label, fs in self.reps(profile).items() for f in fs]
        signs = [o for o in own if o[1] != P.NONE]
        neg_own = [o[0] for o in own if o[1] == P.NONE]
        if not signs:
            raise EnrollError(400, "no_reps", "record some signs first")
        generic = load_generic()
        labels = sorted(set(P.VOCAB) | {l for _, l, _ in signs}) + [P.NONE]
        model = P.train(signs, neg_own + (generic["neg"] if generic else []), labels, extra=generic)
        model.info.update({"profile": profile, "own_reps": len(signs), "own_none": len(neg_own), "generic": bool(generic),
                           "loo": leave_one_out(signs, generic), "train_ms": round((time.perf_counter() - t) * 1000)})
        P.save(model, self.root / profile / "model.npz")
        with self._lock:
            self._models.pop(profile, None)
        return self.info(profile)

    def model(self, profile: str | None) -> P.Model | None:
        """The profile's model; profile "demo" (or a profile without a model) -> the generic demo model, if built."""
        if profile and profile != "demo":
            p = self.root / check_profile(profile) / "model.npz"
            if p.exists():
                mt = p.stat().st_mtime
                with self._lock:
                    hit = self._models.get(profile)
                    if hit and hit[0] == mt:
                        return hit[1]
                m = P.load(p)
                with self._lock:
                    self._models[profile] = (mt, m)
                return m
        with self._lock:
            if not self._default_tried:
                self._default_tried = True
                self._default = P.load(DEFAULT_MODEL) if DEFAULT_MODEL.exists() else None
            return self._default


def load_generic() -> dict | None:
    if not GENERIC.exists():
        return None
    z = np.load(GENERIC, allow_pickle=False)
    return {"X": z["X"].astype(np.float32), "labels": [str(s) for s in z["labels"]], "orig": z["orig"],
            "neg": list(z["neg"].astype(np.float32))}


def leave_one_out(signs: list, generic: dict | None, limit: int = 40) -> dict | None:
    """Quick consistency check shown after training: each own rep against the person's other reps (DTW nearest
    neighbour). A sign that keeps landing on another label needs more (or clearer) reps."""
    if len(signs) < 4:
        return None
    feats = [(P.features(x), l) for x, l, _ in signs]
    feats = [(f, l) for f, l in feats if f is not None][:limit]
    ok = 0
    for i, (f, l) in enumerate(feats):
        others = [g for j, g in enumerate(feats) if j != i]
        bank = np.stack([g[0] for g in others])
        d = P.dtw_dist(f, bank)
        ok += others[int(np.argmin(d))][1] == l
    return {"right": ok, "of": len(feats)}


def read(rec, model: P.Model, x: np.ndarray, vocab: list[str] | None, fps: float = 30.0) -> dict:
    """Sign mode with a closed vocabulary: split a long segment into signs (personal.decode), read each with the
    personal model + the GISLR prior. -> RecognizeResponse fields + signs: [{start, end, options, reject}]."""
    vocab = [v for v in (vocab or P.VOCAB) if v in model.labels] or None
    signs = []
    for a, b in P.decode(model, x, fps, vocab):
        seg = x[a:b]
        p = rec.gislr(seg)
        gp = {rec.index_to_label[i]: float(v) for i, v in enumerate(p)}
        r = model.classify(seg, vocab, gp)
        signs.append({"start": int(a), "end": int(b), "options": r["options"], "reject": r["reject"]})
    take = [s for s in signs if not s["reject"]]
    first = (take or signs or [{"options": []}])[0]
    out = {"mode": "sign", "options": first["options"], "signs": signs, "personal": model.info.get("profile", "demo")}
    if not take:
        out["reject"] = True
    return out
