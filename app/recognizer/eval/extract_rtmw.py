"""Extractor check: RTMW whole-body (rtmlib + onnxruntime, CPU) landmarks for the demo eval clips, in our 543 layout.

Runs in its OWN venv (rtmlib is not a recognizer dependency):
    uv venv %TEMP%/rtm --python 3.12 && uv pip install --python %TEMP%/rtm/Scripts/python.exe rtmlib onnxruntime opencv-python-headless
    %TEMP%/rtm/Scripts/python -m eval.extract_rtmw --mode lightweight --stride 2   # -> out/wlasl-demo/rtmw-<mode>-s<stride>/<name>.npy
then compare with MediaPipe on the same clips:  uv run python -m eval.eval_demo extractor --rtmw ../../out/wlasl-demo/rtmw-lightweight-s2 --stride 2

COCO-WholeBody 133 points -> legacy layout: nose -> pose 0, shoulders 5/6 -> pose 11/12, elbows -> 13/14, wrists -> 15/16,
left hand 91-111 -> 468-488, right hand 112-132 -> 522-542 (same 21-point order as MediaPipe; subject's left / right).
A hand whose mean keypoint score is below --hand-min is missing (NaN). No face mesh (GISLR's lips stay NaN).
Prints timings only.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import cv2
import numpy as np

REPO = Path(__file__).resolve().parents[3]
OUT = Path(os.environ.get("DEMO_DIR") or REPO / "out" / "wlasl-demo")
# WLASL library folder (index.json + videos/): SIGN_LIB, else the folder of SIGN_DICTIONARY; optional (adds the
# library clips of the demo signs to out/wlasl-demo's).
_LIB = os.environ.get("SIGN_LIB") or (str(Path(os.environ["SIGN_DICTIONARY"]).parent) if os.environ.get("SIGN_DICTIONARY") else "")
LIB = Path(_LIB) if _LIB else None
BODY = {0: 0, 5: 11, 6: 12, 7: 13, 8: 14, 9: 15, 10: 16}


def to_layout(kp: np.ndarray, sc: np.ndarray, w: int, h: int, hand_min: float) -> np.ndarray:
    f = np.full((543, 3), np.nan, np.float32)
    for c, m in BODY.items():
        if sc[c] > 0.3:
            f[489 + m] = (kp[c, 0] / w, kp[c, 1] / h, 0)
    for start, dst in ((91, 468), (112, 522)):
        if sc[start:start + 21].mean() >= hand_min:
            f[dst:dst + 21, 0] = kp[start:start + 21, 0] / w
            f[dst:dst + 21, 1] = kp[start:start + 21, 1] / h
            f[dst:dst + 21, 2] = 0
    return f


def videos() -> list[tuple[str, Path, int, int]]:
    """Demo clips, signers with the most clips first (RTMW is slow on CPU: a partial run still allows leave-signer-out)."""
    out = []
    idx = OUT / "index.json"
    if idx.exists():
        for e in json.loads(idx.read_text()):
            out.append((Path(e["file"]).stem, OUT / "videos" / e["file"], e["frame_start"], e["frame_end"], str(e["signer"])))
    lib = json.loads((LIB / "index.json").read_text()) if LIB and (LIB / "index.json").exists() else {}
    for g in ("hello yes no please water hungry sick home help name nice meet you me i where fine happy bye goodbye sorry".split() + ["thank you"]):
        if g in lib:
            p = LIB / lib[g]["file"]
            out.append((p.stem, p, 1, -1, str(lib[g].get("signer_id"))))
    n = {}
    for v in out:
        n[v[4]] = n.get(v[4], 0) + 1
    out.sort(key=lambda v: (-n[v[4]], v[4], v[0]))
    return [v[:4] for v in out]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="lightweight", choices=["lightweight", "balanced", "performance"])
    ap.add_argument("--hand-min", type=float, default=0.35)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="", help="comma-separated clip names (modal_sign_eval.py splits the clips this way)")
    ap.add_argument("--list", action="store_true", help="print the clip names in order and stop")
    ap.add_argument("--stride", type=int, default=1, help="every n-th frame (the eval compares MediaPipe at the same stride)")
    a = ap.parse_args()
    if a.list:
        print(",".join(v[0] for v in videos()))
        return
    from rtmlib import Wholebody

    model = Wholebody(mode=a.mode, backend="onnxruntime", device="cpu")
    dest = OUT / f"rtmw-{a.mode}-s{a.stride}"
    dest.mkdir(parents=True, exist_ok=True)
    ms, n = [], 0
    only = set(filter(None, a.only.split(",")))
    vids = [v for v in videos() if not only or v[0] in only][: a.limit or None]
    for name, path, fs, fe in vids:
        if (dest / f"{name}.npy").exists() or not path.exists():
            continue
        cap = cv2.VideoCapture(str(path))
        frames = []
        i = 0
        while True:
            ok, img = cap.read()
            if not ok:
                break
            i += 1
            if i < fs or (fe > 0 and i > fe) or (i - fs) % a.stride:
                continue
            t = time.perf_counter()
            kps, scores = model(img)
            ms.append((time.perf_counter() - t) * 1000)
            h, w = img.shape[:2]
            if len(kps):
                # the person with the most confident keypoints (WLASL: one signer)
                k = int(np.argmax([(s > 0.3).sum() for s in scores]))
                frames.append(to_layout(kps[k], scores[k], w, h, a.hand_min))
            else:
                frames.append(np.full((543, 3), np.nan, np.float32))
        cap.release()
        np.save(dest / f"{name}.npy", np.stack(frames).astype(np.float16) if frames else np.zeros((0, 543, 3), np.float16))
        n += 1
        if n % 10 == 0:
            print(f"  {n} clips, {np.median(ms):.0f} ms/frame median", flush=True)
    if ms:
        print(f"RTMW {a.mode}: {len(ms)} frames, median {np.median(ms):.0f} ms/frame, p95 {np.percentile(ms, 95):.0f} ms (detector + pose, CPU)")


if __name__ == "__main__":
    main()
