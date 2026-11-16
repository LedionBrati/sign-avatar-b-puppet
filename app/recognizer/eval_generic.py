"""Generic demo model (no enrollment): more signers, signer-invariant features, calibrated rejection, context pick.
Heavy: runs on Modal (modal_sign_eval.py::run_generic), never on the laptop.

    python eval_generic.py summary                     # signers / clips per demo word, what the gather step got
    python eval_generic.py isolated [--variants a,b]   # leave-signer-out (grouped folds), + open set, rejection curves
    python eval_generic.py continuous --variants before,X   # pseudo-sentences (random + demo sentences), compose simulated
    python eval_generic.py all                         # summary + isolated + continuous with the default variants

Data: gather_wlasl.py output (GEN_DIR: meta/ + landmarks/: every reachable WLASL instance of the demo glosses, one clip
per other gloss) + the original eval data (DEMO_DIR caches from demo_data.py: the 92 clips and 400 motion-library
negatives). Duplicates (same video) are dropped. Signer ids are WLASL's, so leave-signer-out holds across both.

Protocol: signers are split into FOLDS groups (greedy, balanced by clips); each group is tested by a model trained on
the other groups only (never its own signers). Every variant and "before" are scored on the same test clips.
"before" = the shipped recipe: the 92 original clips only, none class = 200 motion-library signs + transitions + idle,
base features, reject when the none class wins. Open set: negative glosses are split by gloss (hash): 2/3 can train the
none class, 1/3 (minus every gloss the old none class saw) are the out-of-vocabulary test signs.
Compose simulation (no paid LLM): context.py picks among each piece's top-3 guesses with an add-k bigram over the demo
sentences (the web app's offline path is the same code in app/core/src/context.ts). Reported with the full prior and a
leave-one-sentence-out prior (the tested sentence removed from the bigram), which is the honest one for unseen sentences.
Prints labels and scores only, never landmarks.
"""

from __future__ import annotations

import os

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")

import argparse
import hashlib
import json
import random
import sys
import time
from collections import Counter, defaultdict
from multiprocessing import get_context
from pathlib import Path

import numpy as np

import context as CX
import demo_data as D
import personal as P
import segment as S
import templates as T
from eval_continuous import FPS, build, edit, match
from eval_demo import hands_window, idle, main_segment, transitions

HERE = Path(__file__).resolve().parent
GEN = Path(os.environ.get("GEN_DIR") or HERE.parents[1] / "out" / "wlasl-gen")
META = Path(os.environ.get("META_DIR") or "/vol/meta")
RES = Path(os.environ.get("RESULTS_DIR") or GEN / "results")
FOLDS = 10
LABELS = sorted(P.VOCAB) + [P.NONE]
BASE = {"rot": False, "arclen": False}
# name -> recipe. pool: "old" (92 clips) | "all"; none: "old" (200 motion signs) | "big" (gen train glosses + old 200);
# feat: features() options; aug: "mirror" (the other-hand reading) / "crop" (2 copies, 0-10% trimmed each end).
VARIANTS = {
    "before": {"pool": "old", "none": "old", "feat": BASE},
    "more-signers": {"pool": "all", "none": "old", "feat": BASE},
    "+big-none": {"pool": "all", "none": "big", "feat": BASE},
    "+big-none x2": {"pool": "all", "none": "big", "feat": BASE, "none_w": 2.0},
    "+rot": {"pool": "all", "none": "big", "feat": {"rot": True, "arclen": False}},
    "+arclen": {"pool": "all", "none": "big", "feat": {"rot": False, "arclen": True}},
    "+rot+arclen": {"pool": "all", "none": "big", "feat": {"rot": True, "arclen": True}},
    "+mirror-aug": {"pool": "all", "none": "big", "feat": BASE, "aug": ["mirror"]},
    "+crop-aug": {"pool": "all", "none": "big", "feat": BASE, "aug": ["crop"]},
}


def _fk(cfg: dict) -> str:
    return f"r{int(bool(cfg.get('rot')))}a{int(bool(cfg.get('arclen')))}"


# ── data ──

def load_all():
    """-> demo clips (gen + original, deduplicated; .orig marks the original 92), negatives (train, test), stats."""
    gen_demo, gen_neg, fails = [], [], Counter()
    for f in sorted((GEN / "meta").glob("*.json")):
        m = json.loads(f.read_text())
        if not m.get("ok"):
            for w in m.get("why", []):
                fails[(m["kind"], w.split(":")[0][:30])] += 1
            continue
        p = GEN / "landmarks" / f"{m['name']}.npy"
        if not p.exists():
            continue
        c = D.Clip(m["name"], m["label"], f"s{m['signer']}", np.load(p).astype(np.float32), float(m["fps"]))
        c.url, c.orig, c.src = m["url"], False, m.get("source", "")
        (gen_demo if m["kind"] == "demo" else gen_neg).append(c)
    old = D.load_demo()
    lib = json.loads((META / "index.json").read_text(encoding="utf-8")) if (META / "index.json").exists() else {}
    stem_url = {Path(e["file"]).stem: e.get("source_url") for e in lib.values()}
    old_idx = json.loads((D.DEMO_DIR / "index.json").read_text()) if (D.DEMO_DIR / "index.json").exists() else []
    stem_url.update({Path(e["file"]).stem: e["url"] for e in old_idx})
    gen_by_name = {c.name: c for c in gen_demo}
    gen_urls = {c.url: c for c in gen_demo}
    demo = list(gen_demo)
    for c in old:
        twin = gen_by_name.get(c.name) or gen_urls.get(stem_url.get(c.name))
        if twin is not None:
            twin.orig = True  # the same video: keep one copy, it counts as an original clip
            continue
        c.url, c.orig, c.src = stem_url.get(c.name), True, "library"
        demo.append(c)
    old_neg = D.load_negatives(400)
    old_neg_glosses = {c.label for c in old_neg}
    test_g = lambda g: int(hashlib.md5(g.encode()).hexdigest(), 16) % 3 == 0  # noqa: E731
    neg_train = [c for c in gen_neg if not test_g(c.label)]
    neg_test = [c for c in gen_neg if test_g(c.label) and c.label not in old_neg_glosses]
    return demo, old_neg[:200], neg_train, neg_test, fails


def summary(args):
    demo, old_neg, neg_train, neg_test, fails = load_all()
    print(f"\nDATA: {len(demo)} demo clips ({sum(c.orig for c in demo)} of them in the original set), "
          f"{len({c.signer for c in demo})} signers (original set: {len({c.signer for c in demo if c.orig})})")
    print(f"  negatives: {len(neg_train)} gloss clips can train the none class, {len(neg_test)} other glosses are the open-set test")
    print("  per demo word: clips / signers (original clips / signers)")
    for l in P.VOCAB:
        cs = [c for c in demo if c.label == l]
        o = [c for c in cs if c.orig]
        print(f"    {l:<10} {len(cs):>3} / {len({c.signer for c in cs}):>3}   ({len(o)} / {len({c.signer for c in o})})")
    print("  failed links (kind, reason): " + ", ".join(f"{k[0]}/{k[1]} {n}" for k, n in fails.most_common(10)))
    src = Counter(c.src for c in demo if not c.orig)
    print("  new demo clips by source: " + ", ".join(f"{k} {n}" for k, n in src.most_common()))


# ── shared state for the workers (fork) ──

G: dict = {}


def prepare(need_feats: list[dict]):
    t = time.perf_counter()
    demo, old_neg, neg_train, neg_test, _ = load_all()
    from recognizer import Recognizer

    rec = Recognizer(spell=False, templates=False)
    cache_p = GEN / "gislr-cache.npz"
    gc = dict(np.load(cache_p)) if cache_p.exists() else {}
    n0 = len(gc)
    labels = [rec.index_to_label[i] for i in range(len(rec.index_to_label))]

    def gislr(key, x):
        if key not in gc:
            gc[key] = rec.gislr(x).astype(np.float32)
        return dict(zip(labels, map(float, gc[key])))

    seg = {c.name: main_segment(c) for c in demo + neg_test}
    gp = {c.name: gislr(f"seg|{c.name}", seg[c.name]) for c in demo + neg_test}
    if len(gc) > n0:
        np.savez(cache_p, **gc)
    feats = {}
    rng = np.random.default_rng(0)
    for cfg in need_feats:
        k = _fk(cfg)
        if k in feats:
            continue
        F = {}
        for c in demo:
            x = seg[c.name]
            f = P.features(x, cfg=cfg)
            if f is None:
                continue
            fm = P.features(x, mirror=not T.left_dominant(x), cfg=cfg)
            crops = []
            for _ in range(2):
                n = len(x)
                a, b = int(rng.uniform(0, 0.1) * n), n - int(rng.uniform(0, 0.1) * n)
                fc = P.features(x[a:max(b, a + 4)], cfg=cfg)
                if fc is not None:
                    crops.append(fc)
            F[c.name] = {"f": f, "mirror": fm, "crop": crops}
        negf = {c.name: P.features(c.x, cfg=cfg) for c in old_neg + neg_train}
        feats[k] = {"demo": F, "neg": {n: f for n, f in negf.items() if f is not None}}
    G.update(demo=demo, old_neg=old_neg, neg_train=neg_train, neg_test=neg_test, seg=seg, gp=gp, feats=feats, rec=rec,
             gislr=gislr, cache=(cache_p, gc))
    # folds: signers, greedy by clip count
    cnt = Counter(c.signer for c in demo)
    load = [0] * FOLDS
    fold_of = {}
    for s, n in sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0])):
        k = int(np.argmin(load))
        fold_of[s] = k
        load[k] += n
    G["fold_of"] = fold_of
    print(f"prepared {len(demo)} clips, {len(neg_test)} open-set clips, features {list(feats)} in {time.perf_counter() - t:.0f} s", flush=True)


def train_variant(name: str, exclude: set[str], seed: int = 1) -> P.Model:
    v = VARIANTS[name]
    cfg = {**BASE, **v["feat"]}
    F = G["feats"][_fk(cfg)]
    pool = [c for c in G["demo"] if c.signer not in exclude and (v["pool"] == "all" or c.orig) and c.name in F["demo"]]
    X, labels, orig = [], [], []
    for c in pool:
        d = F["demo"][c.name]
        X.append(d["f"]); labels.append(c.label); orig.append(True)
        for a in v.get("aug", []):
            for fa in ([d["mirror"]] if a == "mirror" and d["mirror"] is not None else d["crop"] if a == "crop" else []):
                X.append(fa); labels.append(c.label); orig.append(False)
    negs = [F["neg"][c.name] for c in G["old_neg"] if c.name in F["neg"]]
    if v["none"] == "big":
        negs += [F["neg"][c.name] for c in G["neg_train"] if c.name in F["neg"]]
    r = random.Random(seed)
    k = 2 if v["none"] == "big" else 1
    negs += [f for f in (P.features(x, cfg=cfg) for x in transitions(pool, 60 * k, r) + idle(pool, r, 30 * k)) if f is not None]
    return P.train([], negs, LABELS, extra={"X": np.stack(X), "labels": labels, "orig": np.array(orig)}, feat=cfg,
                   none_w=v.get("none_w", 1.0), reject={"dtw": 0.0, "t": 0.0})


def _row(r: dict, label: str) -> dict:
    o = r["options"]
    return {"label": label, "top": [x["label"] for x in o[:3]], "conf": [x["confidence"] for x in o[:3]],
            "margin": r.get("margin", -9.0), "dtw": r.get("dtw"), "none": r.get("none")}


def iso_job(job):
    name, k = job
    test_signers = {s for s, f in G["fold_of"].items() if f == k}
    t = time.perf_counter()
    m = train_variant(name, test_signers)
    ms = (time.perf_counter() - t) * 1000
    rows = []
    for c in G["demo"]:
        if c.signer in test_signers:
            rw = _row(m.classify(G["seg"][c.name], P.VOCAB, G["gp"][c.name]), c.label)
            rw.update(name=c.name, orig=c.orig, signer=c.signer)
            rows.append(rw)
    oov = [_row(m.classify(G["seg"][c.name], P.VOCAB, G["gp"][c.name]), c.label) for c in G["neg_test"][k::FOLDS]]
    return name, k, rows, oov, ms


def curve(rows, oov, alpha):
    """Accept when margin - alpha * dtw >= t. -> [(t, in-vocab accepted, right among accepted, right and accepted, OOV accepted)]"""
    s_in = np.array([r["margin"] - alpha * (r["dtw"] if r["dtw"] is not None else 3.0) for r in rows])
    ok = np.array([bool(r["top"]) and r["top"][0] == r["label"] for r in rows])
    s_out = np.array([r["margin"] - alpha * (r["dtw"] if r["dtw"] is not None else 3.0) for r in oov])
    out = []
    for t in np.round(np.arange(-3.0, 4.01, 0.25), 2):
        acc = s_in >= t
        out.append((float(t), acc.mean(), ok[acc].mean() if acc.any() else 0.0, (ok & acc).mean(), (s_out >= t).mean()))
    return out


def isolated(args):
    names = args.variants.split(",") if args.variants else list(VARIANTS)
    prepare([VARIANTS[n]["feat"] for n in names])
    jobs = [(n, k) for n in names for k in range(FOLDS)]
    res = defaultdict(lambda: {"rows": [], "oov": [], "ms": []})
    t = time.perf_counter()
    with get_context("fork").Pool(min(len(jobs), os.cpu_count() or 4)) as pool:
        for name, k, rows, oov, ms in pool.imap_unordered(iso_job, jobs):
            res[name]["rows"] += rows; res[name]["oov"] += oov; res[name]["ms"].append(ms)
    print(f"\nISOLATED, {len(G['demo'])} demo clips, {len({c.signer for c in G['demo']})} signers, {FOLDS} signer-group folds "
          f"(leave-signer-out), {len(G['neg_test'])} open-set signs ({time.perf_counter() - t:.0f} s)")
    print(f"  {'variant':<16} {'top-1 all':>14} {'top-3':>6} {'top-1 orig 92':>15} | OOV accepted, old rule (none wins)")
    for n in names:
        R, O = res[n]["rows"], res[n]["oov"]
        ok = [bool(r["top"]) and r["top"][0] == r["label"] for r in R]
        t3 = [r["label"] in r["top"] for r in R]
        oo = [o for r, o in zip(R, ok) if r["orig"]]
        fa = np.mean([o["margin"] >= 0 for o in O])
        acc_in = np.mean([r["margin"] >= 0 for r in R])
        print(f"  {n:<16} {sum(ok):>4}/{len(ok)} = {np.mean(ok):.0%} {np.mean(t3):>6.0%} {sum(oo):>5}/{len(oo)} = {np.mean(oo):.0%}"
              f" | {fa:.0%} OOV accepted, {acc_in:.0%} demo signs accepted (train {np.median(res[n]['ms']) / 1000:.1f} s/fold)")
    print("\nREJECTION trade-off (accept when margin - a*DTW >= t; margin = log p(best sign) - log p(none)):")
    for n in names:
        R, O = res[n]["rows"], res[n]["oov"]
        for a in (0.0, 1.0, 2.0):
            cv = curve(R, O, a)
            best = min((c for c in cv if c[4] <= 0.10), key=lambda c: -c[3], default=None)
            print(f"  {n:<16} a={a}: " + "  ".join(f"t={c[0]:+.2f} acc {c[1]:.0%}/right {c[3]:.0%}/OOV {c[4]:.0%}" for c in cv[8:22:2])
                  + (f"  | best with OOV<=10%: t={best[0]:+.2f} demo accepted {best[1]:.0%}, right+accepted {best[3]:.0%}, OOV {best[4]:.0%}" if best else ""))
    RES.mkdir(parents=True, exist_ok=True)
    out = RES / f"isolated-{args.tag}.json"
    out.write_text(json.dumps({n: {"rows": v["rows"], "oov": v["oov"]} for n, v in res.items()}))
    print(f"rows -> {out}")


# ── continuous ──

def sentences(rng: random.Random):
    demo = [c for c in G["demo"] if P.active_span(c.x)]
    by = defaultdict(list)
    for c in demo:
        by[c.signer].append(c)
    out = []
    # (R) random 3-4 different signs of one signer (as eval_continuous.py)
    signers = sorted(s for s, v in by.items() if len({c.label for c in v}) >= 3)
    for k in range(60):
        s = signers[k % len(signers)]
        pool = {c.label: c for c in rng.sample(by[s], len(by[s]))}
        out.append(("random", None, rng.sample(list(pool.values()), min(len(pool), rng.choice((3, 4))))))
    # (D) demo sentences: one signer if they have every sign, else the fewest signers (most signs first)
    for sent in [s for s in CX.DEMO_SENTENCES if len(s.split()) >= 2]:
        want = sent.split()
        for rep in range(2):
            order = sorted(by, key=lambda s: (-len(set(want) & {c.label for c in by[s]}), rng.random()))
            clips, used = [], set()
            for w in want:
                for s in order:
                    cand = [c for c in by[s] if c.label == w and c.name not in used]
                    if cand:
                        c = rng.choice(cand)
                        clips.append(c); used.add(c.name)
                        break
            if len(clips) == len(want):
                out.append(("demo", sent, clips))
    return out


def cont_job(job):
    """One (variant, excluded signers): train once, read every piece of every sentence that needs this exclusion."""
    name, excl, items = job
    m = train_variant(name, set(excl))
    out = []
    for idx, pieces in items:
        reads = []
        for (a, b), gp, seg in pieces:
            r = m.classify(seg, P.VOCAB, gp)
            reads.append({"options": r["options"][:3], "margin": r["margin"], "dtw": r["dtw"]})
        out.append((idx, reads))
    return name, out


def continuous(args):
    names = args.variants.split(",") if args.variants else ["before", "+big-none"]
    prepare([VARIANTS[n]["feat"] for n in names])
    rng = random.Random(7)
    sents = sentences(rng)
    t = time.perf_counter()
    data = []
    for kind, sent, clips in sents:
        x, gt = build(clips, args.style)
        cuts = [(g.start, g.end) for g in S.segment_stream(x, FPS)]
        pieces = [((a, b), G["gislr"](f"cont|{args.style}|{'+'.join(c.name for c in clips)}|{a}|{b}", x[a:b]), x[a:b]) for a, b in cuts]
        data.append((kind, sent, clips, gt, cuts, pieces))
    cp, gc = G["cache"]
    np.savez(cp, **gc)
    print(f"\nCONTINUOUS ({args.style}): {sum(d[0] == 'random' for d in data)} random + {sum(d[0] == 'demo' for d in data)} demo-sentence "
          f"pseudo-sentences, segmented + GISLR in {time.perf_counter() - t:.0f} s", flush=True)
    groups = defaultdict(list)
    for i, d in enumerate(data):
        groups[tuple(sorted({c.signer for c in d[2]}))].append((i, d[5]))
    jobs = [(n, ex, items) for n in names for ex, items in groups.items()]
    reads = defaultdict(dict)
    with get_context("fork").Pool(min(len(jobs), os.cpu_count() or 4)) as pool:
        for name, out in pool.imap_unordered(cont_job, jobs):
            for idx, r in out:
                reads[name][idx] = r
    seg_m = sum(match(d[4], d[3])[0] for d in data)
    print(f"  cuts: P {seg_m / max(1, sum(len(d[4]) for d in data)):.0%} R {seg_m / sum(len(d[3]) for d in data):.0%}")
    lm_full = CX.Bigram()
    rule = {"before": (0.0, 0.0)}
    for n in names:
        a_t = rule.get(n, (args.rej_dtw, args.rej_t))
        for kind in ("random", "demo"):
            idxs = [i for i, d in enumerate(data) if d[0] == kind]
            rows = defaultdict(lambda: [0, 0, 0])  # exact, errors, words
            for i in idxs:
                want = [g[2] for g in data[i][3]]
                rd = reads[n][i]
                keep = [r for r in rd if r["options"] and r["margin"] - a_t[0] * (r["dtw"] if r["dtw"] is not None else 3.0) >= a_t[1]]
                outs = {"top-1, no rejection": [r["options"][0]["label"] for r in rd if r["options"]],
                        "top-1, rejected dropped": [r["options"][0]["label"] for r in keep]}
                lm_loo = CX.Bigram([s for s in CX.DEMO_SENTENCES if s != data[i][1]])
                for w in (0.25, 0.5, 1.0):
                    outs[f"context pick w={w}"] = CX.labels(keep, lm=lm_full, lm_weight=w)
                    outs[f"context pick w={w}, sentence left out of the prior"] = CX.labels(keep, lm=lm_loo, lm_weight=w)
                for k, got in outs.items():
                    rows[k][0] += got == want; rows[k][1] += edit(got, want); rows[k][2] += len(want)
            print(f"\n  {n} | {kind} sentences ({len(idxs)}), reject: margin - {a_t[0]}*DTW < {a_t[1]}")
            for k, (ex, er, nw) in rows.items():
                print(f"    {k:<58} exact {ex}/{len(idxs)} = {ex / max(1, len(idxs)):.0%} | WER {er / max(1, nw):.0%}")
    RES.mkdir(parents=True, exist_ok=True)
    (RES / f"continuous-{args.tag}.json").write_text(json.dumps({"sentences": [[d[0], d[1], [g[2] for g in d[3]]] for d in data],
                                                                 "reads": {n: {str(i): r for i, r in v.items()} for n, v in reads.items()}}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["summary", "isolated", "continuous", "all"])
    ap.add_argument("--variants", default="")
    ap.add_argument("--tag", default="run")
    ap.add_argument("--style", default="rest", choices=["rest", "pause", "no pause"])
    ap.add_argument("--rej-dtw", type=float, default=0.0)
    ap.add_argument("--rej-t", type=float, default=0.0)
    a = ap.parse_args()
    if a.what in ("summary", "all"):
        summary(a)
    if a.what in ("isolated", "all"):
        isolated(a)
    if a.what in ("continuous", "all"):
        continuous(a)


if __name__ == "__main__":
    sys.exit(main())
