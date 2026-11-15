"""Honest offline evaluation of the running recognizer on WLASL library clips (signs it was NOT trained on).

    uv run --group eval python eval_wlasl.py                       # all GISLR-vocabulary clips, service at :8788
    uv run --group eval python eval_wlasl.py --limit 60 --url http://127.0.0.1:8787   # through the Node proxy
    uv run --group eval python eval_wlasl.py --spell               # also the fingerspelling sanity check

Pipeline per clip: video -> MediaPipe Tasks HolisticLandmarker (Python, VIDEO mode) -> legacy 543-point packing
(face 478 -> 468, same as app/core/src/landmarks.ts) -> POST /api/recognize over HTTP -> top-1 / top-5.

Landmarks are biometric: they are cached as .npy OUTSIDE the repo (--cache, default %TEMP%/signlayer-eval-cache)
only so reruns are fast, and are never printed. The videos stay in the library folder (WLASL, research use only).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
LIB = Path(r"C:\Users\DELL\Desktop\ai-summit\data\signs")
HOLISTIC = [HERE / "models" / "holistic_landmarker.task", Path(r"C:\Users\DELL\Desktop\sbp-motion\motion\models\holistic_landmarker.task")]
HOLISTIC_URL = "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task"
# GISLR label -> library gloss, only where it is the same sign.
ALIAS = {"thankyou": "thank you", "icecream": "ice cream", "frenchfries": "french fries", "grandpa": "grandfather",
         "minemy": "my", "haveto": "have to"}


def holistic_model() -> Path:
    for p in HOLISTIC:
        if p.exists():
            return p
    print(f"downloading {HOLISTIC_URL}", flush=True)
    HOLISTIC[0].parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(HOLISTIC_URL, HOLISTIC[0])
    return HOLISTIC[0]


def extract(video: Path, model: Path, mirror: bool = False) -> np.ndarray:
    """[frames, 543, 3] float32 in the legacy Holistic layout, NaN for missing parts."""
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    opts = vision.HolisticLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(model)), running_mode=vision.RunningMode.VIDEO)
    frames = []
    with vision.HolisticLandmarker.create_from_options(opts) as det:
        cap = cv2.VideoCapture(str(video))
        fps = cap.get(cv2.CAP_PROP_FPS) or 25
        i = 0
        while True:
            ok, f = cap.read()
            if not ok:
                break
            if mirror:
                f = cv2.flip(f, 1)
            img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
            res = det.detect_for_video(img, int(i * 1000 / fps))
            i += 1
            a = np.full((543, 3), np.nan, np.float32)
            for lms, start, n in ((res.face_landmarks, 0, 468), (res.left_hand_landmarks, 468, 21),
                                  (res.pose_landmarks, 489, 33), (res.right_hand_landmarks, 522, 21)):
                for j, p in enumerate((lms or [])[:n]):
                    a[start + j] = (p.x, p.y, p.z)
            frames.append(a)
        cap.release()
    return np.stack(frames) if frames else np.full((0, 543, 3), np.nan, np.float32)


def cached(video: Path, model: Path, cache: Path, mirror: bool = False) -> np.ndarray:
    key = hashlib.sha1(f"{video.resolve()}|{video.stat().st_size}|{mirror}".encode()).hexdigest()[:16]
    p = cache / f"{key}.npy"
    if p.exists():
        return np.load(p)
    x = extract(video, model, mirror)
    cache.mkdir(parents=True, exist_ok=True)
    np.save(p, x)
    return x


def _job(args):
    video, model, cache, mirror = args
    cached(Path(video), Path(model), Path(cache), mirror)
    return video


def prefetch(jobs: list[tuple], workers: int) -> None:
    """Extract uncached clips in parallel processes first (MediaPipe on CPU is ~10 s per clip)."""
    from concurrent.futures import ProcessPoolExecutor

    if not jobs:
        return
    print(f"extracting landmarks for {len(jobs)} clips with {workers} processes", flush=True)
    t = time.perf_counter()
    with ProcessPoolExecutor(workers) as ex:
        for n, _ in enumerate(ex.map(_job, jobs), 1):
            if n % 20 == 0:
                print(f"  {n}/{len(jobs)} ({time.perf_counter() - t:.0f} s)", flush=True)


def hands_window(x: np.ndarray, max_frames: int = 384) -> np.ndarray:
    """What the web client sends: frames where a hand is visible (auto start/stop), capped at 384."""
    hands = ~np.isnan(x[:, 468:489, 0]).all(1) | ~np.isnan(x[:, 522:543, 0]).all(1)
    idx = np.flatnonzero(hands)
    if len(idx):
        x = x[idx[0]: idx[-1] + 1]
    return x[:max_frames]


def post(base: str, mode: str, x: np.ndarray) -> tuple[dict, float]:
    body = np.ascontiguousarray(x, dtype="<f4").tobytes()
    req = urllib.request.Request(f"{base}/api/recognize?mode={mode}", data=body, method="POST",
                                 headers={"content-type": "application/octet-stream", "X-Frames": str(len(x))})
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        out = json.loads(e.read())
    return out, (time.perf_counter() - t) * 1000


def pct(v: list[float], q: float) -> float:
    return float(np.percentile(v, q)) if v else float("nan")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8788")
    ap.add_argument("--lib", type=Path, default=LIB)
    ap.add_argument("--limit", type=int, default=0, help="0 = every clip in the GISLR vocabulary")
    ap.add_argument("--mirror", action="store_true", help="also evaluate horizontally flipped clips")
    ap.add_argument("--spell", action="store_true", help="fingerspelling sanity check on single-letter clips")
    ap.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir()) / "signlayer-eval-cache")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    ap.add_argument("--json", type=Path, help="write per-clip results (labels and scores only) here")
    a = ap.parse_args()

    index = json.loads((a.lib / "index.json").read_text(encoding="utf8"))
    labels = json.loads((HERE / "models" / "gislr_labels.json").read_text())
    lib = {k.lower(): k for k in index}
    pairs = [(s, lib.get(s.lower()) or lib.get(ALIAS.get(s, ""))) for s in labels]
    pairs = sorted((s, g) for s, g in pairs if g)
    random.Random(0).shuffle(pairs)
    if a.limit:
        pairs = pairs[: a.limit]
    model = holistic_model()
    print(f"{len(pairs)} clips in the GISLR vocabulary; holistic model {model.name}; service {a.url}", flush=True)

    letters = sorted(g for g in index if len(g) == 1 and g.isalpha()) if a.spell else []
    jobs = [(str(a.lib / index[g]["file"]), str(model), str(a.cache), m) for m in ((False, True) if a.mirror else (False,)) for _, g in pairs]
    jobs += [(str(a.lib / index[g]["file"]), str(model), str(a.cache), False) for g in letters]
    prefetch(list(dict.fromkeys(jobs)), a.workers)

    rows, lat, server_ms, extract_s = [], [], [], []
    for mirror in (False, True) if a.mirror else (False,):
        top1 = top5 = 0
        for n, (label, gloss) in enumerate(pairs, 1):
            t = time.perf_counter()
            x = hands_window(cached(a.lib / index[gloss]["file"], model, a.cache, mirror))
            extract_s.append(time.perf_counter() - t)
            if len(x) == 0:
                rows.append({"label": label, "gloss": gloss, "mirror": mirror, "frames": 0, "top5": [], "rank": None})
                continue
            out, ms = post(a.url, "sign", x)
            if "error" in out:
                sys.exit(f"service error: {out['error']}")
            lat.append(ms)
            server_ms.append(out["timings"]["inference_ms"])
            got = [o["label"] for o in out["options"]]
            rank = got.index(label) + 1 if label in got else None
            top1 += rank == 1
            top5 += rank is not None
            rows.append({"label": label, "gloss": gloss, "mirror": mirror, "frames": len(x), "signer": index[gloss].get("signer_id"),
                         "top5": got, "conf": out["options"][0]["confidence"], "rank": rank})
            if n % 20 == 0 or n == len(pairs):
                print(f"  {'mirrored' if mirror else 'unmirrored'} {n}/{len(pairs)} top1 {top1}/{n} top5 {top5}/{n}", flush=True)
        N = len(pairs)
        print(f"{'MIRRORED' if mirror else 'UNMIRRORED'}: N={N} top-1 {top1}/{N} = {top1 / N:.1%}  top-5 {top5}/{N} = {top5 / N:.1%}")

    print(f"latency per request (HTTP round trip, client side): median {statistics.median(lat):.0f} ms, p95 {pct(lat, 95):.0f} ms, max {max(lat):.0f} ms")
    print(f"model inference (server timings.inference_ms): median {statistics.median(server_ms):.0f} ms, p95 {pct(server_ms, 95):.0f} ms")
    fr = [r["frames"] for r in rows if r["frames"]]
    print(f"segment length: median {statistics.median(fr):.0f} frames (min {min(fr)}, max {max(fr)})")
    wrong = [r for r in rows if r["rank"] != 1 and not r["mirror"]]
    print("top-1 misses (label -> predicted):", ", ".join(f"{r['label']}->{r['top5'][0] if r['top5'] else '-'}" for r in wrong[:40]))

    if a.spell:
        print(f"\nfingerspelling sanity: {len(letters)} single-letter clips ({''.join(letters)})", flush=True)
        seqs, ok, spell_lat = {}, 0, []
        for g in letters:
            x = hands_window(cached(a.lib / index[g]["file"], model, a.cache))
            seqs[g] = x
            out, ms = post(a.url, "spell", x)
            spell_lat.append(ms)
            ok += out.get("text", "") == g.upper()
            rows.append({"spell": g, "frames": len(x), "text": out.get("text")})
            print(f"  {g.upper()}: {out.get('text')!r} ({len(x)} frames, {ms:.0f} ms)")
        print(f"single letters exactly right: {ok}/{len(letters)}")
        # Words made by concatenating letter clips (different signers, so hands jump between letters: a hard case).
        for w in ("bad", "dog", "mom", "hi", "jake", "maria"):
            if all(c in seqs for c in w):
                x = np.concatenate([seqs[c] for c in w])[:384]
                out, ms = post(a.url, "spell", x)
                spell_lat.append(ms)
                rows.append({"spell": w, "frames": len(x), "text": out.get("text")})
                print(f"  word {w.upper()}: {out.get('text')!r} ({len(x)} frames, {ms:.0f} ms)")
        print(f"spell latency: median {statistics.median(spell_lat):.0f} ms, max {max(spell_lat):.0f} ms")

    if a.json:
        a.json.write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
