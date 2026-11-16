"""Unit test for score_takes.py with injected landmarks (no MediaPipe, no video).

    motion/.venv/Scripts/python -m pytest pipeline/produce/test_score_takes.py -q
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_takes  # noqa: E402


def _hand(curl: float) -> np.ndarray:
    """21 hand points (right hand), fingers bent by `curl` radians per joint."""
    pts = np.zeros((21, 3))
    bases = [(0.03, 0.0), (0.02, 0.09), (0.0, 0.1), (-0.02, 0.09), (-0.04, 0.08)]
    for f, (x, y) in enumerate(bases):
        p, d = np.array([x, y * 0.5, 0.0]), np.array([0.0, 1.0, 0.0])
        for j in range(4):
            idx = 1 + 4 * f + j
            ang = curl * min(j, 3)
            d = np.array([0.0, math.cos(ang), math.sin(ang)])
            p = p + d * 0.03
            pts[idx] = p
    return pts


def _lm(n: int, curl_for) -> dict:
    x = np.full((n, 543, 3), np.nan, np.float32)
    world = np.full((n, 2, 21, 3), np.nan, np.float32)
    for i in range(n):
        world[i, 1] = _hand(curl_for(i))
        x[i, 522:543] = world[i, 1] + 0.5
    return {"x543": x, "world": world, "fps": 24.0, "w": 540, "h": 720}


def test_per_sign_scores_rank_the_take_that_kept_the_handshape(tmp_path):
    n = 60
    segs = [{"gloss": None, "start": 0, "end": 9}, {"gloss": "A", "start": 5, "end": 30}, {"gloss": None, "start": 26, "end": 35},
            {"gloss": "B", "start": 31, "end": 55}, {"gloss": None, "start": 51, "end": 59}]
    ref = _lm(n, lambda i: 0.05)
    good = _lm(n, lambda i: 0.07)
    bad = _lm(n, lambda i: 0.05 if i < 31 else 1.4)          # sign B curled into a fist
    lost = _lm(n, lambda i: 0.05)
    lost["world"][10:20] = np.nan
    lost["x543"][10:20] = np.nan
    vids = {"ref.mp4": ref, "good.mp4": good, "bad.mp4": bad, "lost.mp4": lost}
    r = score_takes.score("ref.mp4", None, segs, [(0, "good.mp4"), (1, "bad.mp4"), (2, "lost.mp4")], landmarks=lambda p: vids[str(p)])
    assert r["signs"] == ["A", "B"]
    t0, t1, t2 = r["takes"]
    assert [p["index"] for p in t0["per_sign"]] == [0, 1]
    assert t0["per_sign"][1]["vs_ref"]["handshape_change_pct"] == 0
    assert t1["per_sign"][1]["vs_ref"]["handshape_change_pct"] > 50
    assert t1["per_sign"][0]["vs_ref"]["handshape_change_pct"] == 0
    assert t2["per_sign"][0]["vs_ref"]["drop_pct"] > 30
    assert t0["per_sign"][0]["vs_motion"] is None          # no motion file given
    json.dumps(r)                                           # JSON-safe (no NaN objects)
