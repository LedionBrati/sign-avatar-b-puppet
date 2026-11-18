"""Eval data for the demo vocabulary: WLASL clips of the 20 demo signs by different signers, plus other signs.

Sources (all gitignored, WLASL is research use only; landmarks are biometric and never printed or committed):
- out/wlasl-demo/ (fetch_wlasl_demo.py): extra instances downloaded from WLASL_v0.3.json, landmarks/*.npy
- the motion library (MOTION_DIR, default <repo>/out/motion/wlasl): *.raw.json, one per gloss, with signer ids from
  the WLASL library index (SIGN_DICTIONARY=<path-to>/index.json; optional, without it signer ids come from the motion)
Other (out-of-vocabulary) glosses from the motion library are the open-set negatives.
"""

from __future__ import annotations

import json
import os
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np

import templates as T

REPO = Path(__file__).resolve().parents[3]
DEMO_DIR = Path(os.environ.get("DEMO_DIR") or REPO / "out" / "wlasl-demo")  # modal_sign_eval.py points it at a volume


def _motion_dir() -> Path:
    if os.environ.get("MOTION_DIR"):
        return Path(os.environ["MOTION_DIR"])
    return REPO / "out" / "motion" / "wlasl"


def _index_path() -> Path | None:
    p = Path(os.environ["SIGN_DICTIONARY"]) if os.environ.get("SIGN_DICTIONARY") else None
    return p if p and p.exists() else None


# WLASL gloss -> demo label
GLOSS_LABEL = {"hello": "HELLO", "yes": "YES", "no": "NO", "please": "PLEASE", "thank you": "THANK_YOU", "water": "WATER",
               "hungry": "HUNGRY", "sick": "SICK", "home": "HOME", "help": "HELP", "name": "NAME", "nice": "NICE",
               "meet": "MEET", "you": "YOU", "me": "ME", "i": "ME", "where": "WHERE", "fine": "FINE", "happy": "HAPPY",
               "bye": "BYE", "goodbye": "BYE", "sorry": "SORRY"}
# Example sentences over the demo vocabulary (sign labels in signing order, ASL order: WH-sign last). Eval data only:
# eval_generic.py builds its pseudo-sentences from them and fits the context.py bigram prior on them.
DEMO_SENTENCES = [
    "HELLO", "HELLO NICE MEET YOU", "HELLO ME NAME", "HELLO YOU FINE", "HELLO HAPPY MEET YOU", "NICE MEET YOU",
    "NICE MEET YOU BYE", "HAPPY MEET YOU", "YOU NAME", "ME NAME", "THANK_YOU", "THANK_YOU BYE", "THANK_YOU HELP",
    "YES", "YES PLEASE", "YES ME FINE", "YES ME HUNGRY", "YES THANK_YOU", "NO", "NO THANK_YOU", "NO ME FINE", "ME FINE",
    "ME FINE THANK_YOU", "ME HAPPY", "ME HUNGRY", "ME SICK", "ME SORRY", "SORRY", "SORRY ME SICK", "WATER PLEASE",
    "ME WATER PLEASE", "YOU WATER", "YOU HUNGRY", "YOU SICK", "YOU FINE", "YOU HAPPY", "HELP PLEASE", "HELP ME PLEASE",
    "PLEASE HELP ME", "HOME WHERE", "YOU HOME WHERE", "WATER WHERE", "ME HOME", "BYE", "BYE NICE MEET YOU",
    "ME HUNGRY WATER PLEASE", "ME SICK HELP PLEASE", "SORRY ME HOME",
]
# Related glosses kept out of the negatives (same or very close sign to a demo sign).
NOT_NEGATIVE = set(GLOSS_LABEL) | {"hi", "thanks", "my", "mine", "your", "welcome", "excuse", "apologize", "drink",
                                   "house", "ill", "disease", "good", "fine", "glad", "cheerful", "introduce"}


@dataclass
class Clip:
    name: str
    label: str  # demo label, or the gloss for negatives
    signer: str
    x: np.ndarray  # [frames, 543, 3] float32
    fps: float


def _video_fps(path: Path, default: float = 25.0) -> float:
    try:
        import cv2

        cap = cv2.VideoCapture(str(path))
        f = cap.get(cv2.CAP_PROP_FPS)
        cap.release()
        return float(f) if f and 5 <= f <= 120 else default
    except Exception:  # noqa: BLE001
        return default


def _cached(name: str, make) -> list[Clip]:
    """Parsing ~500 raw.json files takes minutes; keep the arrays in out/wlasl-demo/cache-<name>.npz (gitignored)."""
    p = DEMO_DIR / f"cache-{name}.npz"
    if p.exists():
        z = np.load(p, allow_pickle=False)
        meta = json.loads(str(z["meta"]))
        return [Clip(m["name"], m["label"], m["signer"], z[f"x{i}"].astype(np.float32), m["fps"]) for i, m in enumerate(meta)]
    clips = make()
    DEMO_DIR.mkdir(parents=True, exist_ok=True)
    meta = [{"name": c.name, "label": c.label, "signer": c.signer, "fps": c.fps} for c in clips]
    np.savez(p, meta=json.dumps(meta), **{f"x{i}": c.x.astype(np.float16) for i, c in enumerate(clips)})
    return clips


def load_demo(min_frames: int = 8) -> list[Clip]:
    return _cached("demo", lambda: _load_demo(min_frames))


def _load_demo(min_frames: int = 8) -> list[Clip]:
    clips: list[Clip] = []
    seen_urls = set()
    idx_path = DEMO_DIR / "index.json"
    if idx_path.exists():
        for e in json.loads(idx_path.read_text()):
            p = DEMO_DIR / "landmarks" / f"{Path(e['file']).stem}.npy"
            if not p.exists():
                continue
            x = np.load(p).astype(np.float32)
            if len(x) < min_frames or not np.isfinite(x[:, [T.LH, T.RH], 0]).any():
                continue
            seen_urls.add(e["url"])
            clips.append(Clip(Path(e["file"]).stem, e["label"], f"s{e['signer']}", x, _video_fps(DEMO_DIR / "videos" / e["file"])))
    ip = _index_path()
    index = json.loads(ip.read_text()) if ip else {}
    motion = _motion_dir()
    for gloss, label in GLOSS_LABEL.items():
        stems = {Path(index[gloss]["file"]).stem} if gloss in index else set()
        stems |= {p.name[: -len(".raw.json")] for p in motion.glob(f"{gloss.replace(' ', '_')}-*.raw.json")}
        for s in sorted(stems):
            f = motion / f"{s}.raw.json"
            if not f.exists():
                continue
            e = index.get(gloss, {})
            if Path(e.get("file", "")).stem == s and e.get("source_url") in seen_urls:
                continue  # the same video was downloaded again
            raw = json.loads(f.read_text())
            signer = str(raw.get("source", {}).get("signer") or (e.get("signer_id") if Path(e.get("file", "")).stem == s else s))
            x = T.raw_to_frames(raw)
            if len(x) >= min_frames:
                clips.append(Clip(s, label, f"s{signer}", x, float(raw.get("fps") or 25)))
    return clips


def body(x: np.ndarray) -> tuple[np.ndarray, float]:
    """Shoulder midpoint and shoulder width (image coords, medians)."""
    sh = x[:, T.POSE + 11:T.POSE + 13, :2]
    with np.errstate(all="ignore"):
        c = np.nanmedian(sh.mean(1), 0)
        w = float(np.nanmedian(np.linalg.norm(sh[:, 0] - sh[:, 1], axis=-1)))
    if not np.all(np.isfinite(c)):
        c = np.array([0.5, 0.45], np.float32)
    if not np.isfinite(w) or w < 1e-3:
        w = 0.25
    return c.astype(np.float32), w


def align(x: np.ndarray, c: np.ndarray, w: float) -> np.ndarray:
    """Move and scale a clip so its shoulders sit at c with width w (x, y only), so clips can be spliced."""
    c0, w0 = body(x)
    y = x.copy()
    y[..., :2] = (x[..., :2] - c0) * (w / w0) + c
    return y


def resample_fps(x: np.ndarray, fps: float, target: float) -> np.ndarray:
    """Nearest-frame resampling to the target frame rate."""
    if abs(fps - target) < 0.5 or len(x) < 2:
        return x
    n = max(2, int(round(len(x) * target / fps)))
    return x[np.round(np.linspace(0, len(x) - 1, n)).astype(int)]


def load_negatives(n: int = 300, seed: int = 0) -> list[Clip]:
    """Other signs from the motion library (open-set negatives), seeded sample."""
    return _cached(f"neg{n}-{seed}", lambda: _load_negatives(n, seed))


def _load_negatives(n: int, seed: int) -> list[Clip]:
    motion = _motion_dir()
    stems = sorted(p.name[: -len(".raw.json")] for p in motion.glob("*.raw.json"))
    def gloss_of(s: str) -> str:
        return s.rsplit("-", 1)[0].replace("_", " ")
    stems = [s for s in stems if gloss_of(s) not in NOT_NEGATIVE and len(gloss_of(s)) > 1]
    random.Random(seed).shuffle(stems)
    out = []
    for s in stems[:n]:
        raw = json.loads((motion / f"{s}.raw.json").read_text())
        x = T.raw_to_frames(raw)
        if len(x) >= 8 and np.isfinite(x[:, [T.LH, T.RH], 0]).any():
            out.append(Clip(s, gloss_of(s), f"s{raw.get('source', {}).get('signer')}", x, float(raw.get("fps") or 25)))
    return out
