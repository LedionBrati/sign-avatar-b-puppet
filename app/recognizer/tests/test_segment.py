"""segment.py: rest / pause / gone / max cuts, fragments dropped, and the shared fixture that app/core/src/segment.ts
must cut the same way (app/core/test/segment.test.mjs).

    .venv/Scripts/python tests/test_segment.py --write    # regenerate app/core/test/fixtures/segment-fixture.json
"""

import json
import sys
from pathlib import Path

import numpy as np

import segment as S

FIXTURE = Path(__file__).resolve().parents[2] / "core" / "test" / "fixtures" / "segment-fixture.json"
FPS = 30
SW = 0.25  # shoulder width (image units)
C = np.array([0.5, 0.45])  # shoulder midpoint
HAND = np.stack([np.linspace(0, 0.3, 21), -np.linspace(0, 1, 21)], 1) * 0.3  # flat hand, shoulder widths


def frame(rw, lw=None, jitter=0.0, rng=None):
    """One 543 x 3 frame: shoulders + a right hand at rw (wrist, shoulder widths), optional left hand at lw."""
    f = np.full((543, 3), np.nan, np.float32)
    f[S.POSE + 11, :2] = C + [SW / 2, 0]
    f[S.POSE + 12, :2] = C - [SW / 2, 0]
    f[S.POSE + 11:S.POSE + 13, 2] = 0
    for w, start in ((rw, S.RH), (lw, S.LH)):
        if w is None:
            continue
        pts = C + (np.asarray(w) + HAND) * SW
        if jitter and rng is not None:
            pts = pts + rng.normal(0, jitter, pts.shape)
        f[start:start + 21, :2] = pts
        f[start:start + 21, 2] = 0
    return f


def script(rng, jitter=0.002):
    """rest, raise, sign A, hold, sign B, hold, lower, rest, a twitch at rest, hands leave, raise, sign C, gone."""
    out = []
    rest = np.array([-0.6, 2.2])
    up = np.array([-0.6, 0.4])
    def move(a, b, n):
        for t in np.linspace(0, 1, n):
            out.append(frame(a + (b - a) * (0.5 - 0.5 * np.cos(np.pi * t)), jitter=jitter, rng=rng))
    def hold(p, n):
        for _ in range(n):
            out.append(frame(p, jitter=jitter, rng=rng))
    def circle(p, n, r=0.35, turns=2):
        for t in np.linspace(0, 1, n):
            a = 2 * np.pi * turns * t
            out.append(frame(p + r * np.array([np.cos(a) - 1, np.sin(a)]), jitter=jitter, rng=rng))
    hold(rest, 15)
    move(rest, up, 8)
    circle(up, 24)  # sign A
    hold(up, 15)  # hold -> pause
    move(up, up + [0.6, -0.5], 6)
    move(up + [0.6, -0.5], up + [0.6, 0.3], 6)  # sign B (a short tap)
    move(up + [0.6, 0.3], up + [0.6, -0.5], 6)
    hold(up + [0.6, -0.5], 15)
    move(up + [0.6, -0.5], rest, 8)  # lower: dropped (mostly downward)
    hold(rest, 20)
    move(rest, rest + [0.05, -0.1], 2)  # twitch at rest: ignored
    hold(rest + [0.05, -0.1], 10)
    for _ in range(15):
        out.append(frame(None))  # hands out of frame
    move(rest, up, 8)
    circle(up, 140, turns=7)  # one long run of signing without a pause (> maxMs): cut at the slowest moment
    for _ in range(15):
        out.append(frame(None))  # gone
    return np.stack(out)


def test_cuts_rest_pause_gone():
    x = script(np.random.default_rng(0))
    segs = S.segment_stream(x, FPS)
    reasons = [s.reason for s in segs]
    assert reasons[:2] == ["pause", "pause"], reasons
    assert all(s.end - s.start >= 9 for s in segs)
    a = segs[0]
    assert 15 <= a.start <= 23 and 44 <= a.end <= 58  # sign A: from the raise to the start of the hold
    assert "gone" in reasons or "max" in reasons
    assert len(segs) <= 5  # the lowering and the twitch are not signs


def test_still_hands_never_start():
    rng = np.random.default_rng(1)
    x = np.stack([frame([-0.6, 0.4], jitter=0.003, rng=rng) for _ in range(90)])  # hands up, only tracking jitter
    assert S.segment_stream(x, FPS) == []
    x = np.stack([frame([-0.6, 2.2], jitter=0.003, rng=rng) for _ in range(90)])  # hands at rest
    assert S.segment_stream(x, FPS) == []


def test_valleys_split_two_movements():
    rng = np.random.default_rng(2)
    x = script(rng)[23:115]
    v = S.valleys(x, FPS)
    assert v, "expected a valley between sign A and sign B"


def _pack(x):
    """Only the points the segmenter reads (pose 11/12, both hands), 5 decimals."""
    def pts(a):
        return None if not np.isfinite(a[0, 0]) else np.round(a[:, :2], 5).tolist()
    return [{"pose11": pts(f[S.POSE + 11:S.POSE + 12]), "pose12": pts(f[S.POSE + 12:S.POSE + 13]),
             "lh": pts(f[S.LH:S.LH + 21]), "rh": pts(f[S.RH:S.RH + 21])} for f in x]


def _unpack(rows):
    x = np.full((len(rows), 543, 3), np.nan, np.float32)
    for i, r in enumerate(rows):
        for key, start, n in (("pose11", S.POSE + 11, 1), ("pose12", S.POSE + 12, 1), ("lh", S.LH, 21), ("rh", S.RH, 21)):
            if r[key] is not None:
                x[i, start:start + n, :2] = np.array(r[key], np.float32)
                x[i, start:start + n, 2] = 0
    return x


def test_fixture_matches():
    """The committed fixture (frames + expected cuts) still cuts the same here; the Node test checks segment.ts."""
    fx = json.loads(FIXTURE.read_text())
    x = _unpack(fx["frames"])
    got = [[s.start, s.end, s.reason] for s in S.segment_stream(x, fx["fps"])]
    assert got == fx["cuts"]
    assert fx["config"] == S.SEG  # segment.ts must carry the same numbers (checked there too)


if __name__ == "__main__" and "--write" in sys.argv:
    x = _unpack(_pack(script(np.random.default_rng(0))))  # rounded first, so both sides read the same numbers
    cuts = [[s.start, s.end, s.reason] for s in S.segment_stream(x, FPS)]
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps({"fps": FPS, "config": S.SEG, "cuts": cuts, "frames": _pack(x)}, separators=(",", ":")))
    print(f"{FIXTURE}: {len(x)} frames, cuts {cuts}")
