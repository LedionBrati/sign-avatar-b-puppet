"""Continuous test without a human signer: pseudo-sentences spliced from one WLASL signer's demo clips.

    .venv/Scripts/python eval_demo.py continuous [--sentences 60]

Each sentence = 3-4 different demo clips of ONE test signer, shoulders aligned, at 30 fps, in three styles:
- rest:     whole clips one after the other (hands go down to rest between signs, as in WLASL)
- pause:    each sign's active part (hands up), joined by a short glide (6 frames) of the hands; signs end in their hold
- no pause: as pause, but the hold at the end of each sign is cut too (4-frame glide): signing straight through
Ground truth per sign = its active part. A cut matches a sign at temporal IoU >= 0.3 (one-to-one, greedy).
Models are trained leave-signer-out (the sentence's signer is never in training), as in eval_demo.py isolated.
Baseline = main's web segmenter (lib/segmenter.ts before this change: hands visible + motion, 0.6 s still,
550 ms fragments ignored) + main's recognizer and client rules.
"""

from __future__ import annotations

import random
import statistics
import time
from collections import defaultdict

import numpy as np

import demo_data as D
import personal as P
import segment as S

FPS = 30.0
IOU = 0.3


# ── main's web segmenter (app/web/src/lib/segmenter.ts before this branch), on 543 x 3 frames ──

OLD = {"goneMs": 400, "stillMs": 600, "minMs": 500, "maxMs": 4000, "preRoll": 8, "minFrames": 4, "moveThresh": 0.004, "minSegMs": 550}
KEY5 = (0, 4, 8, 12, 20)


def _old_motion(a, b):
    if a is None:
        return 0.0
    s, n = 0.0, 0
    for st in (468, 522):
        pa, pb = np.isfinite(a[st, 0]), np.isfinite(b[st, 0])
        if not pa or not pb:
            if pa or pb:
                s += 0.02
                n += 1
            continue
        for k in KEY5:
            s += float(np.hypot(*(a[st + k, :2] - b[st + k, :2])))
            n += 1
    return s / n if n else 0.0


def old_segments(x: np.ndarray, fps: float) -> list[tuple[int, int]]:
    out = []
    state, buf, last_hand, prev = "armed", [], -1, None
    t0 = last_hand_t = last_move_t = 0.0
    no_hand = still = 0
    moved = False
    for i in range(len(x)):
        f, t = x[i], i * 1000 / fps
        hands = bool(np.isfinite(x[i, 468, 0]) or np.isfinite(x[i, 522, 0]))
        m = _old_motion(prev, f)
        prev = f
        if state == "armed":
            if not hands:
                buf, last_hand = [], -1
                continue
            buf.append(i)
            if len(buf) > OLD["preRoll"]:
                buf.pop(0)
            last_hand = len(buf) - 1
            if m > OLD["moveThresh"]:
                state, t0, last_hand_t, last_move_t, moved, no_hand, still = "recording", t, t, t, True, 0, 0
            continue
        buf.append(i)
        if hands:
            last_hand, last_hand_t, no_hand = len(buf) - 1, t, 0
        else:
            no_hand += 1
        if m > OLD["moveThresh"]:
            last_move_t, moved, still = t, True, 0
        else:
            still += 1
        done = (no_hand >= 2 and t - last_hand_t > OLD["goneMs"]) or (moved and still >= 2 and t - last_move_t > OLD["stillMs"] and t - t0 > OLD["minMs"]) \
            or t - t0 > OLD["maxMs"] or len(buf) >= 384
        if done:
            keep = buf[: max(last_hand + 3, 0)]
            if len(keep) >= OLD["minFrames"] and t - t0 >= OLD["minSegMs"]:
                out.append((keep[0], keep[-1] + 1))
            state, buf, last_hand, no_hand, still, moved = "armed", [], -1, 0, 0, False
    return out


# ── pseudo-sentences ──

def _glide(a: np.ndarray, b: np.ndarray, n: int) -> np.ndarray:
    """n frames moving every point linearly from frame a to frame b (points missing in either stay missing)."""
    w = np.linspace(0, 1, n + 2)[1:-1].reshape(-1, 1, 1)
    return (a[None] * (1 - w) + b[None] * w).astype(np.float32)


def _hold_end(x: np.ndarray, a: int, b: int) -> int:
    """Last frame before the closing hold of the active part [a, b]: where the speed last dropped below moveOff."""
    v = S.speeds(x, FPS)
    j = b
    while j > a + 5 and v[j] < S.SEG["moveOff"]:
        j -= 1
    return min(b, j + 2)


def build(clips: list[D.Clip], style: str) -> tuple[np.ndarray, list[tuple[int, int, str]]]:
    parts, gt, pos = [], [], 0
    ref_c, ref_w = None, None
    prev_last = None
    for c in clips:
        x = D.resample_fps(c.x, c.fps, FPS)
        if ref_c is None:
            ref_c, ref_w = D.body(x)
        x = D.align(x, ref_c, ref_w)
        span = P.active_span(x)
        a, b = span
        if style == "rest":
            gt.append((pos + a, pos + b + 1, c.label))
            parts.append(x)
            pos += len(x)
            continue
        if style == "no pause":
            b = _hold_end(x, a, b)
        seg = x[a: b + 1]
        if prev_last is not None:
            g = _glide(prev_last, seg[0], 6 if style == "pause" else 4)
            parts.append(g)
            pos += len(g)
        else:  # lead-in rest
            parts.append(x[:a])
            pos += a
        gt.append((pos, pos + len(seg), c.label))
        parts.append(seg)
        pos += len(seg)
        prev_last = seg[-1]
    if style != "rest":
        last = clips[-1]
        x = D.align(D.resample_fps(last.x, last.fps, FPS), ref_c, ref_w)
        parts.append(x[P.active_span(x)[1] + 1:])
    return np.concatenate(parts), gt


def match(pred: list[tuple[int, int]], gt: list[tuple[int, int, str]]) -> tuple[int, dict]:
    """Greedy one-to-one at IoU >= IOU -> (matches, pred index -> gt index)."""
    pairs = []
    for i, (a, b) in enumerate(pred):
        for j, (c, d, _) in enumerate(gt):
            inter = max(0, min(b, d) - max(a, c))
            iou = inter / (max(b, d) - min(a, c))
            if iou >= IOU:
                pairs.append((iou, i, j))
    used_p, used_g, m = set(), set(), {}
    for iou, i, j in sorted(pairs, reverse=True):
        if i not in used_p and j not in used_g:
            used_p.add(i); used_g.add(j); m[i] = j
    return len(m), m


def edit(a: list, b: list) -> int:
    d = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        p, d[0] = d[0], i
        for j in range(1, len(b) + 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] != b[j - 1]))
    return d[-1]


def continuous(args):
    from eval_demo import Baseline, client_rules, fold_train, idle, neg_features, transitions

    demo = D.load_demo()
    negs = D.load_negatives(400)
    neg_train = negs[: len(negs) // 2]
    by = defaultdict(list)
    for c in demo:
        by[c.signer].append(c)
    rng = random.Random(7)
    n_sent = getattr(args, "sentences", 0) or 60
    signers = [s for s, v in by.items() if len({c.label for c in v}) >= 3]
    sentences = []
    for k in range(n_sent):
        s = signers[k % len(signers)]
        pool = {c.label: c for c in rng.sample(by[s], len(by[s]))}
        sentences.append((s, rng.sample(list(pool.values()), min(len(pool), rng.choice((3, 4))))))
    print(f"\nCONTINUOUS: {len(sentences)} pseudo-sentences from {len(signers)} signers (3-4 signs each), leave-signer-out")
    base = Baseline()
    models = {}
    t = time.perf_counter()
    for s in sorted({s for s, _ in sentences}):
        train = [c for c in demo if c.signer != s]
        r2 = random.Random(1)
        negatives = neg_features(neg_train) + transitions(train, 60, r2) + idle(train, r2, 30)
        models[s] = fold_train(train, negatives, {})
    print(f"  trained {len(models)} leave-signer-out models in {time.perf_counter() - t:.0f} s")

    # (cutter, reader): old = main's web segmenter; new = segment.py; dec = segment.py + personal.decode
    systems = {
        "main: old segmenter + main recognizer": ("old", "main"),
        "new segmenter + main recognizer": ("new", "main"),
        "new segmenter + main scores, demo signs only": ("new", "vocab"),
        "new segmenter + personal, strict gate (unsure dropped)": ("new", "personal-strict"),
        "new segmenter + personal (only 'no sign' dropped)": ("new", "personal"),
        "new segmenter + personal (always top-1)": ("new", "personal-all"),
        "new segmenter + decoder + personal (only 'no sign' dropped)": ("dec", "personal"),
        "new segmenter + decoder + personal (always top-1)": ("dec", "personal-all"),
    }
    for style in ("rest", "pause", "no pause"):
        tot = defaultdict(lambda: defaultdict(float))
        lat = []
        for s, clips in sentences:
            x, gt = build(clips, style)
            want = [g[2] for g in gt]
            model = models[s]
            stems = {c.name for c in clips}  # main's template bank holds the library clips: never match a clip to itself
            new = [(g.start, g.end) for g in S.segment_stream(x, FPS)]
            cuts = {"old": old_segments(x, FPS), "new": new, "dec": []}
            for a0, b0 in new:
                cuts["dec"] += [(a0 + a, a0 + b) for a, b in P.decode(model, x[a0:b0], FPS, P.VOCAB)]
            reads: dict = {}
            for sys_name, (cut, reader) in systems.items():
                pieces = cuts[cut]
                got = []
                for a, b in pieces:
                    seg = x[a:b]
                    if reader == "main":
                        lab = client_rules(base.options(seg, exclude=stems))
                    elif reader == "vocab":
                        lab = base.vocab_only(seg, stems)
                    else:
                        if (a, b) not in reads:
                            t0 = time.perf_counter()
                            reads[(a, b)] = model.classify(seg, P.VOCAB, base.gislr(seg))
                            lat.append((time.perf_counter() - t0) * 1000)
                        r = reads[(a, b)]
                        drop = (reader == "personal" and r["reject"]) or (reader == "personal-strict" and (r["reject"] or r["unsure"]))
                        lab = None if not r["options"] or drop else r["options"][0]["label"]
                    if lab:
                        got.append(lab)
                m, _ = match(pieces, gt)
                T_ = tot[sys_name]
                T_["pred"] += len(pieces); T_["gt"] += len(gt); T_["match"] += m
                T_["exact"] += got == want
                T_["err"] += edit(got, want); T_["words"] += len(want)
        print(f"\n  style: {style}")
        for sys_name in systems:
            T_ = tot[sys_name]
            p = T_["match"] / max(1, T_["pred"])
            r = T_["match"] / max(1, T_["gt"])
            print(f"    {sys_name:<60} cuts P {p:.0%} R {r:.0%} | sentences exactly right {int(T_['exact'])}/{len(sentences)} "
                  f"({T_['exact'] / len(sentences):.0%}) | word error rate {T_['err'] / T_['words']:.0%}")
        if lat:
            print(f"    new: read one piece (GISLR + personal) median {statistics.median(lat):.0f} ms, p95 {np.percentile(lat, 95):.0f} ms")
