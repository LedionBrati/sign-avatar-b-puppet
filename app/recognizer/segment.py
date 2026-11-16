"""Cut continuous signing into sign segments: the Python mirror of app/core/src/segment.ts (same rules, same numbers).

Per frame (legacy 543 x 3 layout, image coords), in shoulder widths (origin = shoulder midpoint, y down):
- hand up: a hand is tracked and its wrist is above UP_ON; it stays "up" until it drops below UP_OFF (hysteresis);
- speed: mean displacement of the wrist + 5 fingertips per second (over LAG frames, so tracking jitter does not
  look like motion), smoothed (EMA, TAU_MS).

armed -> recording when a hand is up AND moving (speed > MOVE_ON). Recording ends at
- rest:  hands tracked but none up for REST_MS (dropped to the lap / sides),
- gone:  no hand tracked for GONE_MS (out of frame; short tracking dropouts do not cut a sign),
- pause: hands up but speed < MOVE_OFF for PAUSE_MS (the hold at the end of a sign / between two signs),
- max:   longer than MAX_MS: cut at the slowest moment in the middle part; the rest carries on as the next segment.
A finished segment is kept only if it lasts MIN_MS, the hands travelled MIN_PATH, and its wrist travel is not
mostly downward (MAX_DESCENT: that is the hands going back to rest after a hold). PRE / POST frames of context.

valleys(x, fps) lists candidate cut points inside one segment (local speed minima) for personal.decode, which
splits a long segment into the signs that explain it best (the sliding-window fallback for signing without pauses).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

LH, RH, POSE = 468, 522, 489
KEY = (0, 4, 8, 12, 16, 20)  # wrist + fingertips
LAG = 3  # frames: motion is measured against the frame this far back

SEG = {
    "upOn": 1.0,  # wrist above this (shoulder widths below the shoulder line) = hand up
    "upOff": 1.3,  # ...and up until it drops below this
    "moveOn": 0.9,  # speed (shoulder widths / s, smoothed) that starts a segment
    "moveOff": 0.45,  # below this = still
    "tauMs": 80,  # speed smoothing time constant
    "pauseMs": 260,  # hands up and still this long -> end of a sign
    "restMs": 140,  # hands tracked, none up, this long -> end
    "goneMs": 350,  # no hand tracked this long -> end
    "minMs": 300,  # shorter segments are fragments
    "maxMs": 3500,  # longer -> cut at the slowest moment (the server's decoder splits long segments better)
    "minPath": 0.5,  # hand travel (shoulder widths, wrist + fingertips) a sign needs
    "maxDescent": 0.8,  # share of wrist travel that is downward above which a segment is "hands going to rest"
    "pre": 3,  # frames of context before the start
    "post": 2,  # ...and after the end
}


def shoulder(frame: np.ndarray) -> tuple[float, float, float] | None:
    """(mid x, mid y, width) from pose 11 / 12, None if not tracked."""
    a, b = frame[POSE + 11], frame[POSE + 12]
    if not (math.isfinite(a[0]) and math.isfinite(b[0])):
        return None
    w = math.hypot(a[0] - b[0], a[1] - b[1])
    if w < 1e-3:
        return None
    return (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, w


@dataclass
class Obs:
    up: bool
    hands: bool
    speed: float  # smoothed, shoulder widths / s
    dist: float  # wrist + fingertip displacement since the previous frame (shoulder widths)
    down: float  # downward wrist displacement (shoulder widths)
    wpath: float  # wrist displacement (shoulder widths)


@dataclass
class Segment:
    start: int  # frame index (inclusive)
    end: int  # frame index (exclusive)
    reason: str  # rest | gone | pause | max | flush


@dataclass
class Segmenter:
    """Online: push(frame, t_ms) once per frame; returns the segments that finished at this frame."""

    cfg: dict = field(default_factory=lambda: dict(SEG))

    def __post_init__(self):
        self.reset()

    def reset(self):
        self.i = -1
        self.ring: list[tuple[float, np.ndarray]] = []  # the last LAG frames
        self.sh = None  # smoothed (cx, cy, w)
        self.up = [False, False]
        self.speed = 0.0
        self.state = "armed"
        self.start = 0
        self.last_up_t = -1e9  # last frame with a hand up (or no hand tracked at all: that is "gone"'s job)
        self.last_hand_t = -1e9
        self.last_hand_i = self.last_up_i = -1
        self.still_since = None  # (t, frame) the hands became still
        self.hist: list[tuple[float, Obs]] = []  # per frame from self.start (armed: the last PRE + 1 frames)

    def observe(self, f: np.ndarray, t: float) -> Obs:
        c = self.cfg
        f = np.asarray(f, np.float64)  # the web client does this maths in float64 too
        s = shoulder(f)
        if s is not None:
            self.sh = s if self.sh is None else tuple(0.8 * p + 0.2 * q for p, q in zip(self.sh, s))
        cx, cy, w = self.sh if self.sh is not None else (0.5, 0.45, 0.25)
        hands = False
        for h, start in enumerate((LH, RH)):
            if not math.isfinite(f[start, 0]):
                self.up[h] = False
                continue
            hands = True
            y = (f[start, 1] - cy) / w
            self.up[h] = bool(y < (c["upOff"] if self.up[h] else c["upOn"]))
        # Displacement against the frame LAG frames back (divided by LAG): tracking jitter does not add up the way it
        # does frame to frame, real motion is the same.
        dist, n, down, wpath = 0.0, 0, 0.0, 0.0
        ref = self.ring[0] if len(self.ring) == LAG else None
        if ref is not None:
            for start in (LH, RH):
                for k in KEY:
                    p, q = ref[1][start + k], f[start + k]
                    if math.isfinite(p[0]) and math.isfinite(q[0]):
                        d = math.hypot(q[0] - p[0], q[1] - p[1])
                        dist += d
                        n += 1
                        if k == 0:
                            wpath += d / w
                            down += max(0.0, q[1] - p[1]) / w
        dist = dist / n / w / LAG if n else 0.0
        wpath, down = wpath / LAG, down / LAG
        dt = max((t - ref[0]) / LAG if ref is not None else 33.0, 1.0)
        a = 1 - math.exp(-dt / c["tauMs"])
        self.speed += a * (dist / (dt / 1000) - self.speed)
        self.ring.append((t, f))
        if len(self.ring) > LAG:
            self.ring.pop(0)
        return Obs(any(self.up), hands, self.speed, dist, down, wpath)

    def push(self, f: np.ndarray, t: float) -> list[Segment]:
        c = self.cfg
        self.i += 1
        o = self.observe(f, t)
        if o.hands:
            self.last_hand_t, self.last_hand_i = t, self.i
        if o.up or not o.hands:
            self.last_up_t = t
        if o.up:
            self.last_up_i = self.i
        self.hist.append((t, o))
        if self.state == "armed":
            if len(self.hist) > c["pre"] + 1:
                self.hist.pop(0)
            if o.up and o.speed > c["moveOn"]:
                self.state = "recording"
                self.start = self.i - (len(self.hist) - 1)
                self.still_since = None
            return []
        if o.speed < c["moveOff"]:
            if self.still_since is None:
                self.still_since = (t, self.i)
        elif o.speed > c["moveOn"] * 0.75:
            self.still_since = None
        if t - self.last_hand_t > c["goneMs"]:
            return self._finish(min(self.i + 1, self.last_hand_i + 1 + c["post"]), "gone")
        if t - self.last_up_t > c["restMs"]:
            return self._finish(min(self.i + 1, self.last_up_i + 1 + c["post"]), "rest")
        if self.still_since is not None and o.up and t - self.still_since[0] > c["pauseMs"]:
            return self._finish(min(self.i + 1, self.still_since[1] + c["post"]), "pause")
        if t - self.hist[0][0] > c["maxMs"]:
            return self._finish(self._valley(), "max", carry=True)
        return []

    def _valley(self) -> int:
        """Frame index of the slowest moment in the middle of the current segment."""
        c = self.cfg
        t0, tn = self.hist[0][0], self.hist[-1][0]
        best, bi = float("inf"), len(self.hist) // 2
        for j, (t, o) in enumerate(self.hist):
            if t - t0 >= c["minMs"] and tn - t >= c["minMs"] and o.speed < best:
                best, bi = o.speed, j
        return self.start + bi

    def keep(self, hist: list[tuple[float, Obs]]) -> bool:
        c = self.cfg
        if len(hist) < 2:
            return False
        dur = hist[-1][0] - hist[0][0]
        path = sum(o.dist for _, o in hist[1:])
        wpath = sum(o.wpath for _, o in hist[1:])
        down = sum(o.down for _, o in hist[1:])
        return dur >= c["minMs"] and path >= c["minPath"] and not (wpath > 0 and down / wpath > c["maxDescent"])

    def _finish(self, end: int, reason: str, carry: bool = False) -> list[Segment]:
        k = end - self.start
        seg = self.hist[:k]
        out = [Segment(self.start, end, reason)] if self.keep(seg) else []
        if carry:
            self.hist = self.hist[k:]
            self.start = end
        else:
            self.state = "armed"
            self.hist = self.hist[-(self.cfg["pre"] + 1):]
        self.still_since = None
        return out

    def flush(self) -> list[Segment]:
        if self.state != "recording":
            return []
        return self._finish(self.i + 1, "flush")


def segment_stream(x: np.ndarray, fps: float, cfg: dict | None = None) -> list[Segment]:
    """All segments of a whole recording [frames, 543, 3] at fps."""
    s = Segmenter(dict(SEG, **(cfg or {})))
    out = []
    for i in range(len(x)):
        out += s.push(x[i], i * 1000.0 / fps)
    return out + s.flush()


def speeds(x: np.ndarray, fps: float) -> np.ndarray:
    """Smoothed speed per frame (shoulder widths / s)."""
    s = Segmenter()
    return np.array([s.observe(x[i], i * 1000.0 / fps).speed for i in range(len(x))])


def valleys(x: np.ndarray, fps: float, min_gap_ms: float = 300, depth: float = 0.6) -> list[int]:
    """Candidate cut frames inside one segment: local speed minima at most depth x the lower of the two
    neighbouring peaks, at least min_gap_ms from each other and from the ends."""
    v = speeds(x, fps)
    n = len(v)
    gap = max(1, int(round(min_gap_ms * fps / 1000)))
    out: list[int] = []
    for i in range(gap, n - gap):
        if v[i] > v[i - 1] or v[i] > v[i + 1]:
            continue
        left, right = v[max(0, i - 2 * gap):i].max(), v[i + 1:i + 1 + 2 * gap].max()
        if v[i] <= depth * min(left, right) and (not out or i - out[-1] >= gap):
            out.append(i)
    return out
