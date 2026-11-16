"""Demo-vocabulary eval without a human signer: WLASL clips of the 20 demo signs by different signers.

    .venv/Scripts/python eval_demo.py isolated     # leave-signer-out, feature / model choices, open-set
    .venv/Scripts/python eval_demo.py continuous   # pseudo-sentences: segmentation P/R + sentence accuracy
    .venv/Scripts/python eval_demo.py all

Data: demo_data.py (run fetch_wlasl_demo.py --extract first). MOTION_DIR / SIGN_DICTIONARY as in build_templates.py.
Baseline = the pipeline on main: GISLR + WLASL templates merged (recognizer.py), then the web client's rules
(dejunk, demo-word boost, 25% bar); for continuous signing, the old web segmenter (lib/segmenter.ts, ported below).
New = segment.py + personal.py (closed vocabulary, GISLR prior, open-set rejection).
Prints labels and scores only, never landmarks.
"""

from __future__ import annotations

import os

# BLAS on every core spins against the browser and MediaPipe on a busy laptop (a 1000 x 2000 SVD took 40+ s):
# a few threads are faster here. Must be set before numpy loads.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("OMP_NUM_THREADS", "4")

import argparse
import json
import random
import statistics
import sys
import time
from collections import Counter, defaultdict

import numpy as np

import demo_data as D
import personal as P
import segment as S
import templates as T

GLOSS_TEXT = {"hello": "HELLO", "yes": "YES", "no": "NO", "please": "PLEASE", "thank you": "THANK_YOU", "water": "WATER",
              "hungry": "HUNGRY", "sick": "SICK", "home": "HOME", "help": "HELP", "name": "NAME", "nice": "NICE",
              "meet": "MEET", "you": "YOU", "me": "ME", "i": "ME", "where": "WHERE", "fine": "FINE", "happy": "HAPPY",
              "bye": "BYE", "goodbye": "BYE", "sorry": "SORRY"}
# Web client rules on main (SignToSpeak.tsx / stream.ts)
DEMO_WORDS = set("hello how are you your today day good evening night morning thank you thankyou all very much judge luck lucky can i me my have some coffee water please want build company nice meet name where bathroom yes no fine happy see later tomorrow help sorry".split())
JUNK = set("alligator animal balloon bee bird carrot cat chocolate clown cow cowboy donkey doll duck elephant fireman frenchfries frog giraffe goose gum hen horse kitty lion mitten owl owie penny pig puppy puzzle snack tiger vacuum wolf zebra zipper underwear".split())


def client_rules(r: dict) -> str | None:
    """main's web client: reject -> nothing; dejunk; demo words x1.5; top-1 if >= 0.25. -> demo label, other text, or None."""
    if r.get("reject"):
        return None
    opts = sorted(r["options"], key=lambda o: -o["confidence"])
    top = opts[0] if opts else None
    if not (top and top["label"].lower() in JUNK and top["confidence"] >= 0.7 and not any(o["label"].lower() not in JUNK and o["confidence"] >= 0.1 for o in opts)):
        opts = [o for o in opts if o["label"].lower() not in JUNK]
    boosted = []
    for o in opts:
        t = (o.get("text") or o["label"]).lower()
        c = min(1.0, o["confidence"] * 1.5) if t in DEMO_WORDS or o["label"].lower() in DEMO_WORDS else o["confidence"]
        boosted.append((c, t))
    boosted = [b for b in sorted(boosted, reverse=True) if b[0] >= 0.25]
    if not boosted:
        return None
    t = boosted[0][1]
    return GLOSS_TEXT.get(t, f"other:{t}")


class Baseline:
    """recognizer.py's sign path (GISLR + templates merged), with the clip's own template excluded."""

    def __init__(self):
        from recognizer import Recognizer, label_text, motion_energy, should_reject

        self.rec = Recognizer(spell=False, templates=True)
        self.label_text, self.motion_energy, self.should_reject = label_text, motion_energy, should_reject

    def gislr(self, x):
        p = self.rec.gislr(x)
        return {self.rec.index_to_label[i]: float(v) for i, v in enumerate(p)}

    def options(self, x, exclude=None, gp=None):
        gp = gp or self.gislr(x)
        top = sorted(gp.items(), key=lambda kv: -kv[1])[:5]
        opts = [{"label": l, "text": self.label_text(l), "confidence": round(v, 4)} for l, v in top]
        opts = T.merge(opts, self.rec.templates.match(x, 5, exclude=exclude), 5)
        m = self.motion_energy(x)
        r = {"options": opts, "motion": m}
        if self.should_reject(opts, m):
            r["reject"] = True
        return r

    def vocab_only(self, x, exclude=None, gp=None):
        """Same scores, but only the demo labels may win (what simply restricting the vocabulary would give)."""
        gp = gp or self.gislr(x)
        g = [{"label": P.GISLR_OF[l], "text": P.text_of(l), "confidence": gp.get(P.GISLR_OF[l], 0.0)} for l in P.VOCAB if l in P.GISLR_OF]
        bank = self.rec.templates
        d = bank.distances(x, exclude)
        keep = [i for i, gl in enumerate(bank.glosses) if GLOSS_TEXT.get(gl.lower()) in P.VOCAB]
        t = T.scores_to_options(d[keep], [bank.glosses[i] for i in keep], 5) if d is not None else []
        m = T.merge(sorted(g, key=lambda o: -o["confidence"])[:5], t, 5)
        if not m:
            return None
        return GLOSS_TEXT.get(m[0]["text"].lower())


def hands_window(x):
    hands = ~np.isnan(x[:, 468:489, 0]).all(1) | ~np.isnan(x[:, 522:543, 0]).all(1)
    idx = np.flatnonzero(hands)
    return x[idx[0]: idx[-1] + 1] if len(idx) else x


def main_segment(c) -> np.ndarray:
    """The segment the new segmenter cuts from an isolated clip (the longest one), else the hands window."""
    segs = S.segment_stream(c.x, c.fps)
    if not segs:
        return hands_window(c.x)
    s = max(segs, key=lambda s: s.end - s.start)
    return c.x[s.start:s.end]


# ── transitions (negatives for the none class, and for the continuous test) ──

def splice(parts: list[np.ndarray]) -> np.ndarray:
    """Concatenate clips with their shoulders aligned to the first one."""
    c, w = D.body(parts[0])
    return np.concatenate([parts[0]] + [D.align(p, c, w) for p in parts[1:]])


def transitions(clips, n: int, rng: random.Random) -> list[np.ndarray]:
    """Windows that straddle two signs of the same signer: the second half of one + the first half of the next."""
    by = defaultdict(list)
    for c in clips:
        by[c.signer].append(c)
    pool = [v for v in by.values() if len(v) > 1]
    out = []
    for _ in range(n * 3):
        if not pool or len(out) >= n:
            break
        g = rng.choice(pool)
        a, b = rng.sample(g, 2)
        sa, sb = P.active_span(a.x), P.active_span(b.x)
        if not sa or not sb:
            continue
        ma, mb = (sa[0] + sa[1]) // 2, (sb[0] + sb[1]) // 2
        out.append(splice([a.x[ma: sa[1] + 1], b.x[sb[0]: mb + 1]]))
    return out


def idle(clips, rng: random.Random, n: int) -> list[np.ndarray]:
    """Hands at rest / barely moving: the frames before the sign starts and after it ends."""
    out = []
    for c in rng.sample(clips, min(n, len(clips))):
        s = P.active_span(c.x)
        if s and s[0] > 8:
            out.append(c.x[: s[0]])
        if s and len(c.x) - s[1] > 8:
            out.append(c.x[s[1] + 1:])
    return out


# ── isolated, leave-signer-out ──

_SEG: dict[str, np.ndarray] = {}
_FEAT: dict[str, np.ndarray] = {}


def seg_cached(c) -> np.ndarray:
    if c.name not in _SEG:
        _SEG[c.name] = main_segment(c)
    return _SEG[c.name]


def neg_features(clips) -> list[np.ndarray]:
    """Features of negative clips, computed once."""
    out = []
    for c in clips:
        if c.name not in _FEAT:
            _FEAT[c.name] = P.features(c.x)
        if _FEAT[c.name] is not None:
            out.append(_FEAT[c.name])
    return out


class GislrCache:
    """GISLR probabilities per (clip, kind), kept in out/wlasl-demo/cache-gislr.npz between runs."""

    def __init__(self, base):
        self.base, self.path = base, D.DEMO_DIR / "cache-gislr.npz"
        self.d = dict(np.load(self.path)) if self.path.exists() else {}
        self.labels = [base.rec.index_to_label[i] for i in range(len(base.rec.index_to_label))]
        self.dirty = False

    def get(self, key, x):
        if key not in self.d:
            self.d[key] = self.base.rec.gislr(x).astype(np.float32)
            self.dirty = True
        return dict(zip(self.labels, map(float, self.d[key])))

    def save(self):
        if self.dirty:
            np.savez(self.path, **self.d)


def fold_train(train, negatives, cfg):
    clips = [(c.x if cfg.get("raw") else seg_cached(c), c.label, 1.0) for c in train]
    return P.train(clips, negatives if cfg.get("none", True) else [], aug=cfg.get("aug", P.AUG), l2=cfg.get("l2", 1e-2),
                   steps=cfg.get("steps", 300))


def dtw_knn(bank, bidx, labels, f, k=1):
    d = P.dtw_dist(f, bank)
    order = np.argsort(d)[:k]
    votes = Counter(labels[bidx[i]] for i in order)
    return votes.most_common(1)[0][0], float(d[order[0]])


def isolated(args):
    rng = random.Random(0)
    demo = D.load_demo()
    negs = D.load_negatives(400)
    half = len(negs) // 2
    neg_train, neg_test = negs[:half], negs[half:]
    signers = Counter(c.signer for c in demo)
    labels_have = sorted({c.label for c in demo})
    print(f"demo clips: {len(demo)} from {len(signers)} signers, {len(labels_have)} labels: "
          + " ".join(f"{l}:{sum(c.label == l for c in demo)}" for l in labels_have))
    print(f"out-of-vocabulary clips: {len(neg_train)} train (none class) / {len(neg_test)} test (open set)")
    base = Baseline()
    t = time.perf_counter()
    seg_of = {c.name: seg_cached(c) for c in demo + neg_test}
    gc = GislrCache(base)
    gp = {c.name: gc.get(f"seg|{c.name}", seg_of[c.name]) for c in demo + neg_test}
    gp_win = {c.name: gc.get(f"win|{c.name}", hands_window(c.x)) for c in demo + neg_test}
    gc.save()
    print(f"GISLR on {len(gp)} segments: {time.perf_counter() - t:.0f} s")
    neg_f = neg_features(neg_train)

    # Baseline (main) on the isolated clips, own template excluded.
    res = defaultdict(list)
    for c in demo:
        x = hands_window(c.x)
        r = base.options(x, exclude={c.name}, gp=gp_win[c.name])
        res["main"].append(client_rules(r) == c.label)
        res["main, vocab only"].append(base.vocab_only(x, {c.name}, gp_win[c.name]) == c.label)
    fa_main = sum(client_rules(base.options(hands_window(c.x), gp=gp_win[c.name])) in P.VOCAB for c in neg_test)

    # New: leave-signer-out folds.
    variants = {
        "gislr only (demo vocabulary)": {"model": "gislr"},
        "logreg on gislr output (250-d embedding)": {"model": "glr"},
        "dtw 1-nn (hand features)": {"model": "dtw"},
        "logreg (hand features) + dtw": {"model": "lr", "fuse": False},
        "logreg + dtw + gislr prior": {"model": "lr", "fuse": True},
        "logreg + dtw + gislr prior, no augmentation": {"model": "lr", "fuse": True, "aug": 0},
    }
    if args.quick:
        variants = {k: v for k, v in variants.items() if k in ("logreg + dtw + gislr prior",)}
    conf = defaultdict(list)  # (variant) -> [(correct, top1 conf, rejected)]
    openset = defaultdict(list)
    train_ms = []
    folds = sorted(signers)
    for s in folds:
        test = [c for c in demo if c.signer == s]
        train = [c for c in demo if c.signer != s]
        if args.k:
            by = defaultdict(list)
            for c in train:
                by[c.label].append(c)
            train = [c for v in by.values() for c in random.Random(hash(s) & 0xffff).sample(v, min(args.k, len(v)))]
        print(f"  fold {folds.index(s) + 1}/{len(folds)} signer {s}: {len(test)} test clips", flush=True)
        tr_rng = random.Random(1)
        negatives = neg_f + transitions(train, 60, tr_rng) + idle(train, tr_rng, 30)
        model, dtw_bank, glr = None, None, None
        for name, cfg in variants.items():
            if cfg["model"] in ("lr",) and (model is None or cfg.get("aug", P.AUG) != model.info.get("aug")):
                t = time.perf_counter()
                model = fold_train(train, negatives, cfg)
                model.info["aug"] = cfg.get("aug", P.AUG)
                train_ms.append((time.perf_counter() - t) * 1000)
            for c in test:
                x = seg_of[c.name]
                if cfg["model"] == "dtw":
                    if dtw_bank is None:
                        dtw_bank = np.array([P.features(seg_cached(t_)) for t_ in train])
                    bank, lab = dtw_bank, [t_.label for t_ in train]
                    f = P.features(x)
                    d = P.dtw_dist(f, bank)
                    pred = lab[int(np.argmin(d))]
                    conf[name].append((pred == c.label, float(-d.min()), False))
                elif cfg["model"] == "glr":
                    if glr is None:
                        emb = lambda n: np.log(np.maximum(np.array(list(gp[n].values())), 1e-6))  # noqa: E731
                        glr = P.LogReg(steps=200).fit(np.stack([emb(t_.name) for t_ in train]), np.array([P.VOCAB.index(t_.label) for t_ in train]), len(P.VOCAB))
                    pr = glr.proba(emb(c.name)[None])[0]
                    pred = P.VOCAB[int(np.argmax(pr))]
                    conf[name].append((pred == c.label, float(pr.max()), False))
                elif cfg["model"] == "gislr":
                    g = P.gislr_share(gp[c.name], P.VOCAB)
                    pred = P.VOCAB[int(np.argmax(g))]
                    conf[name].append((pred == c.label, float(g.max() / g.sum()), False))
                else:
                    r = model.classify(x, P.VOCAB, gp[c.name] if cfg.get("fuse") else None)
                    pred = r["options"][0]["label"] if r["options"] else None
                    conf[name].append((pred == c.label, r["options"][0]["confidence"] if r["options"] else 0.0, r["reject"]))
            if cfg["model"] == "lr" and cfg.get("aug", P.AUG) == P.AUG:
                # open set: a few OOV test clips per fold (each OOV clip is scored by one fold's model)
                for c in neg_test[folds.index(s)::len(folds)]:
                    r = model.classify(seg_of[c.name], P.VOCAB, gp[c.name] if cfg.get("fuse") else None)
                    openset[name].append(r["reject"])
    n = len(demo)
    print(f"\nISOLATED, top-1 over the {len(P.VOCAB)}-sign demo vocabulary, N = {n} clips, leave-signer-out ({len(folds)} folds)"
          + (f", K = {args.k} training clips per sign" if args.k else ", all other signers' clips"))
    print(f"  {'main (GISLR + templates + client rules)':<44} {sum(res['main'])}/{n} = {np.mean(res['main']):.0%}")
    print(f"  {'main scores, demo vocabulary only':<44} {sum(res['main, vocab only'])}/{n} = {np.mean(res['main, vocab only']):.0%}")
    for name, rows in conf.items():
        ok = [r[0] for r in rows]
        acc = [r[0] for r in rows if not r[2]]
        line = f"  {name:<44} {sum(ok)}/{len(ok)} = {np.mean(ok):.0%}"
        if any(r[2] for r in rows):
            line += f" | accepted {len(acc)}/{len(rows)} ({len(acc) / len(rows):.0%}), right when accepted {np.mean(acc) if acc else 0:.0%}"
        print(line)
    print(f"  train time per fold (logreg, {P.AUG} aug): median {statistics.median(train_ms):.0f} ms" if train_ms else "")
    print(f"\nOPEN SET: {len(neg_test)} other WLASL signs (not in the demo vocabulary)")
    print(f"  main: said a demo word for {fa_main}/{len(neg_test)} ({fa_main / len(neg_test):.0%})")
    for name, rows in openset.items():
        fa = sum(1 for r in rows if not r)
        print(f"  {name}: accepted {fa}/{len(rows)} ({fa / len(rows):.0%}) as a demo sign")
    if args.json:
        json.dump({"isolated": {k: [list(map(float, r)) for r in v] for k, v in conf.items()}}, open(args.json, "w"))


def extractor(args):
    """MediaPipe Holistic vs another extractor's landmarks (extract_rtmw.py) on the same clips and frames: hand found
    in the signing frames, and leave-signer-out top-1 of the hand-feature classifier (logreg + DTW, no GISLR: RTMW has
    no face mesh), each trained and tested on its own extractor's landmarks."""
    from pathlib import Path

    other = Path(args.rtmw)
    demo = [c for c in D.load_demo() if (other / f"{c.name}.npy").exists()]
    st = args.stride
    sets = {"mediapipe holistic": {c.name: c.x[::st] for c in demo},
            other.name: {c.name: np.load(other / f"{c.name}.npy").astype(np.float32) for c in demo}}
    print(f"\nEXTRACTOR: {len(demo)} clips, every {st}. frame, {len({c.signer for c in demo})} signers")
    for name, xs in sets.items():
        found, total = 0, 0
        for c in demo:
            x, ref = xs[c.name], sets["mediapipe holistic"][c.name]
            n = min(len(x), len(ref))
            span = P.active_span(ref[:n]) or P.active_span(x[:n])
            if not span:
                continue
            seg = x[span[0]:span[1] + 1]
            dom = T.LH if T.left_dominant(ref[:n]) else T.RH
            found += int(np.isfinite(seg[:, dom, 0]).sum())
            total += len(seg)
        ok, segs = [], {}
        for c in demo:
            cut = S.segment_stream(xs[c.name], c.fps / st)
            q = max(cut, key=lambda g: g.end - g.start) if cut else None
            segs[c.name] = xs[c.name][q.start:q.end] if q else hands_window(xs[c.name])
        for s in sorted({c.signer for c in demo}):
            train = [c for c in demo if c.signer != s]
            test = [c for c in demo if c.signer == s]
            m = P.train([(segs[c.name], c.label, 1.0) for c in train if P.features(segs[c.name]) is not None], [], sorted(set(P.VOCAB)), aug=4)
            for c in test:
                r = m.classify(segs[c.name], P.VOCAB)
                ok.append(bool(r["options"]) and r["options"][0]["label"] == c.label)
        print(f"  {name:<28} dominant hand found in {found / max(1, total):.0%} of signing frames | leave-signer-out top-1 {sum(ok)}/{len(ok)} = {np.mean(ok):.0%}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["isolated", "continuous", "all", "extractor"])
    ap.add_argument("--k", type=int, default=0, help="training clips per sign (0 = all other signers')")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("--rtmw", help="extractor: folder of the other extractor's .npy landmarks")
    ap.add_argument("--stride", type=int, default=2)
    a = ap.parse_args()
    if a.what == "extractor":
        return extractor(a)
    if a.what in ("isolated", "all"):
        isolated(a)
    if a.what in ("continuous", "all"):
        from eval_continuous import continuous
        continuous(a)


if __name__ == "__main__":
    sys.exit(main())
