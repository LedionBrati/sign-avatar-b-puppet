"""Pretrained sign recognizers (no training): GISLR isolated signs and ASL fingerspelling, both TFLite on CPU.

Input to both is the LEGACY MediaPipe Holistic layout (see app/core/src/landmarks.ts):
    float32 [frames, 543, 3], face 0-467 | left hand 468-488 | pose 489-521 | right hand 522-542, NaN = missing.

Landmark data is biometric (face points): this module never logs or stores it.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

import numpy as np

POINTS = 543
MAX_FRAMES = 384
OFFSETS = {"face": 0, "left_hand": 468, "pose": 489, "right_hand": 522}
COUNTS = {"face": 468, "left_hand": 21, "pose": 33, "right_hand": 21}
MODELS_DIR = Path(os.environ.get("RECOGNIZER_MODELS") or Path(__file__).resolve().parent / "models")

# GISLR labels that are not plain English words -> the text a client shows / speaks (labels stay unchanged).
# Mostly the same as LABEL_TEXT in app/core/src/compose.ts; here tuned for adult conversation (potty -> bathroom,
# callonphone -> call, hesheit -> he).
LABEL_TEXT = {
    "thankyou": "thank you",
    "callonphone": "call",
    "minemy": "my",
    "hesheit": "he",
    "weus": "we",
    "haveto": "have to",
    "glasswindow": "window",
    "frenchfries": "french fries",
    "icecream": "ice cream",
    "potty": "bathroom",
    "owie": "hurt",
    "shhh": "quiet",
    "TV": "TV",
    "yourself": "you",
}

# GISLR is a toddler-vocabulary model (PopSign): these childhood words are unlikely in adult conversation, and the
# model is forced to pick one of its 250 labels even for transitions, so their confidence is scaled by KID_PRIOR
# before ranking and merging. KID_PRIOR=1.0 (env) disables it.
KID_LABELS = frozenset("""
alligator animal balloon bee bird carrot cat chocolate clown cow cowboy donkey doll duck elephant fireman frenchfries
frog giraffe goose gum hen horse kitty lion mitten owl owie penny pig puppy puzzle snack tiger vacuum wolf zebra
zipper underwear
""".split())
KID_PRIOR = float(os.environ.get("KID_PRIOR", "0.35"))

# "No sign" signal: mean per-frame displacement of the wrists + fingertips (in shoulder widths). Below MOTION_MIN the
# hands barely moved (rest, a held pose, tracking jitter); a best merged confidence below REJECT_CONF means neither
# recognizer really knows the segment. Either sets reject: true (options are kept so clients can still show chips).
# Calibration: 40 random WLASL clips (25 fps, rest frames included) 0.067-0.16+ (min-median); a held pose with
# 0.002 / 0.004 landmark jitter ~0.015 / ~0.03. So 0.025 = clearly below any real sign.
MOTION_POINTS = np.array([h + i for h in (468, 522) for i in (0, 4, 8, 12, 16, 20)], dtype=np.int64)
SHOULDERS = (489 + 11, 489 + 12)
MOTION_MIN = float(os.environ.get("MOTION_MIN", "0.025"))
REJECT_CONF = float(os.environ.get("REJECT_CONF", "0.2"))

# The fingerspelling tflite returns this phrase (as one-hot rows) when its own confidence head is low or the
# clip is very short: a Kaggle-metric trick (cfg_2.dummy_phrase_ids). For a user it means "no reading".
FS_DUMMY = "2 a-e -aroe"


def label_text(label: str) -> str:
    return LABEL_TEXT.get(label) or LABEL_TEXT.get(label.lower()) or label.lower().replace("_", " ")


class RecognizeError(ValueError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


def parse_frames(body: bytes, frames_header: str | None) -> np.ndarray:
    """Validate the raw float32 body against X-Frames and return [frames, 543, 3]."""
    if frames_header is None or not str(frames_header).strip().isdigit():
        raise RecognizeError(400, "bad_frames", "X-Frames header must be a positive integer")
    frames = int(frames_header)
    if frames < 1:
        raise RecognizeError(400, "bad_frames", "X-Frames must be at least 1")
    if frames > MAX_FRAMES:
        raise RecognizeError(413, "too_many_frames", f"{frames} frames; the limit is {MAX_FRAMES}")
    want = frames * POINTS * 3 * 4
    if len(body) != want:
        raise RecognizeError(400, "bad_body_size", f"body is {len(body)} bytes; {frames} frames x 543 x 3 float32 = {want}")
    x = np.frombuffer(body, dtype="<f4").reshape(frames, POINTS, 3)
    return x.astype(np.float32, copy=True)


def spell_columns(selected_columns: list[str]) -> tuple[np.ndarray, np.ndarray]:
    """Map the model's selected columns (e.g. "x_right_hand_0", "y_face_61", "z_pose_13") to (point, coord) indices."""
    pts, coords = [], []
    for col in selected_columns:
        axis, rest = col.split("_", 1)
        part, idx = rest.rsplit("_", 1)
        i = int(idx)
        if part not in OFFSETS or axis not in "xyz" or not 0 <= i < COUNTS[part]:
            raise ValueError(f"unknown landmark column {col}")
        pts.append(OFFSETS[part] + i)
        coords.append("xyz".index(axis))
    return np.array(pts, dtype=np.int64), np.array(coords, dtype=np.int64)


def apply_prior(p: np.ndarray, index_to_label: dict[int, str], prior: float | None = None) -> np.ndarray:
    """GISLR probabilities with the kid-vocabulary labels scaled by prior (not renormalised: a down-weighted label
    should not push the others up)."""
    w = KID_PRIOR if prior is None else prior
    if w == 1.0:
        return p
    out = p.copy()
    for i, label in index_to_label.items():
        if label in KID_LABELS and i < len(out):
            out[i] *= w
    return out


def motion_energy(x: np.ndarray) -> float:
    """Mean frame-to-frame displacement of the wrists + fingertips (both hands, x/y), in shoulder widths. NaN-safe:
    only point pairs tracked in both frames count; no such pair (or no hands) -> 0.0."""
    if x.ndim != 3 or x.shape[0] < 2:
        return 0.0
    pts = x[:, MOTION_POINTS, :2].astype(np.float64)
    d = np.linalg.norm(np.diff(pts, axis=0), axis=-1)  # [frames-1, points], NaN where either frame misses the point
    d = d[np.isfinite(d)]
    if not d.size:
        return 0.0
    sw = np.linalg.norm(x[:, SHOULDERS[0], :2].astype(np.float64) - x[:, SHOULDERS[1], :2], axis=-1)
    sw = sw[np.isfinite(sw) & (sw > 1e-3)]
    width = float(np.median(sw)) if sw.size else 0.25  # no shoulders tracked: a typical webcam framing
    return float(np.mean(d) / width)


def should_reject(options: list[dict], motion: float, motion_min: float | None = None, min_conf: float | None = None) -> bool:
    m = MOTION_MIN if motion_min is None else motion_min
    c = REJECT_CONF if min_conf is None else min_conf
    best = max((o["confidence"] for o in options), default=0.0)
    return motion < m or best < c


def softmax(logits: np.ndarray) -> np.ndarray:
    z = logits.astype(np.float64) - np.max(logits)
    e = np.exp(z)
    return e / e.sum()


class Recognizer:
    """Loads both models once; each interpreter has its own lock (TFLite interpreters are not thread-safe)."""

    def __init__(self, models_dir: Path = MODELS_DIR, spell: bool = True, templates: bool | None = None):
        from ai_edge_litert.interpreter import Interpreter

        md = Path(models_dir)
        self.labels = json.loads((md / "gislr_labels.json").read_text())
        self.index_to_label = {v: k for k, v in self.labels.items()}
        self._sign = Interpreter(str(md / "gislr.tflite")).get_signature_runner()
        self._sign_lock = threading.Lock()
        self.models = {"sign": f"gislr ({len(self.labels)} signs)"}
        # Template matching on WLASL motion (templates.py) for the words GISLR lacks; TEMPLATES=off disables it.
        self.templates = None
        if templates is None:
            templates = os.environ.get("TEMPLATES", "on").lower() not in ("off", "0", "false", "no")
        bank = md / "templates.npz"
        if templates and bank.exists():
            from templates import TemplateBank

            self.templates = TemplateBank(bank)
            self.models["sign"] += f" + wlasl templates ({len(self.templates)} signs)"
        self._spell = None
        if spell:
            args = json.loads((md / "fs_args.json").read_text())
            self.fs_points, self.fs_coords = spell_columns(args["selected_columns"])
            chars = json.loads((md / "fs_chars.json").read_text())
            self.fs_chars = {v: k for k, v in chars.items()}
            self._spell = Interpreter(str(md / "fs.tflite")).get_signature_runner()
            self._spell_lock = threading.Lock()
            self.models["spell"] = f"asl-fingerspelling cfg_2/fold-1 ({len(self.fs_points)} columns)"

    def warm_up(self) -> dict:
        x = np.random.default_rng(0).random((24, POINTS, 3), dtype=np.float32)
        out = {}
        for mode in ("sign", "spell") if self._spell else ("sign",):
            t = time.perf_counter()
            self.recognize(mode, x)
            out[mode] = round((time.perf_counter() - t) * 1000)
        return out

    def recognize(self, mode: str, x: np.ndarray, top: int = 5) -> dict:
        t0 = time.perf_counter()
        if mode == "sign":
            with self._sign_lock:
                logits = np.asarray(self._sign(inputs=x)["outputs"]).reshape(-1)
            inference_ms = (time.perf_counter() - t0) * 1000
            p = softmax(logits)
            if not np.all(np.isfinite(p)):
                p = np.full_like(p, 1 / len(p))
            p = apply_prior(p, self.index_to_label)
            order = np.argsort(-p)[:top]
            options = [{"label": self.index_to_label[int(i)], "text": label_text(self.index_to_label[int(i)]),
                        "confidence": round(float(p[i]), 4)} for i in order]
            if self.templates is not None:
                from templates import merge

                options = merge(options, self.templates.match(x, top), top)
                inference_ms = (time.perf_counter() - t0) * 1000
            motion = motion_energy(x)
            result = {"mode": "sign", "options": options, "motion": round(motion, 4)}
            if should_reject(options, motion):
                result["reject"] = True
        elif mode == "spell":
            if self._spell is None:
                raise RecognizeError(503, "spell_unavailable", "fingerspelling model not loaded")
            cols = x[:, self.fs_points, self.fs_coords]  # [frames, 390]
            with self._spell_lock:
                scores = np.asarray(self._spell(inputs=np.ascontiguousarray(cols, dtype=np.float32))["outputs"])
            inference_ms = (time.perf_counter() - t0) * 1000
            text, conf = self.decode_spell(scores)
            options = [{"label": f"#{text}", "text": text, "confidence": conf}] if text else []
            result = {"mode": "spell", "options": options, "text": text}
        else:
            raise RecognizeError(400, "bad_mode", "mode must be sign or spell")
        result["frames"] = int(x.shape[0])
        result["timings"] = {"inference_ms": round(inference_ms, 2), "total_ms": round((time.perf_counter() - t0) * 1000, 2)}
        return result

    def decode_spell(self, scores: np.ndarray) -> tuple[str, float]:
        """Rows of token scores (already cut at EOS by the model) -> uppercase text and mean per-character probability.

        Vocabulary: 59 characters (fs_chars.json), then pad P=59, start S=60, end E=61 (cfg_2.py); other ids are dropped.
        """
        if scores.ndim != 2 or scores.shape[0] == 0:
            return "", 0.0
        ids = scores.argmax(-1)
        raw = "".join(self.fs_chars.get(int(i), "") for i in ids)
        if raw == FS_DUMMY:
            return "", 0.0
        probs = [float(softmax(row)[i]) for row, i in zip(scores, ids) if int(i) in self.fs_chars]
        # Spell mode is one word or name: the model (trained on phrases, addresses, URLs) sometimes inserts a
        # space at a pause between letters ("B A D"), so spaces are dropped.
        return raw.upper().replace(" ", ""), round(float(np.mean(probs)) if probs else 0.0, 4)
