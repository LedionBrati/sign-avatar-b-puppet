"""Build the generic demo-vocabulary model from WLASL clips (no person enrolled yet), for enroll.py / personal.py.

    .venv/Scripts/python build_demo_model.py          # -> models/demo_generic.npz + models/demo_model.npz (~10-30 s)

Input: demo_data.py (out/wlasl-demo from fetch_wlasl_demo.py --extract, plus the motion library). Output holds
derived features only (no landmarks): every demo clip's features and AUG augmented copies (labels per row), and
features of the none class (other WLASL signs, transitions between signs, idle hands). demo_model.npz is that data
alone, fitted: Sign to speak uses it as profile "demo"; "Train my signs" adds a person's reps on top.
"""

from __future__ import annotations

import os

os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")

import random
import time

import numpy as np

import demo_data as D
import enroll as E
import personal as P
from eval_demo import idle, seg_cached, transitions


def main():
    t = time.perf_counter()
    demo = D.load_demo()
    negs = D.load_negatives(400)
    rng = np.random.default_rng(0)
    X, labels, orig = [], [], []
    for c in demo:
        x = seg_cached(c)
        f = P.features(x)
        if f is None:
            continue
        X.append(f); labels.append(c.label); orig.append(True)
        for _ in range(P.AUG):
            fa = P.features(P.augment(x, rng))
            if fa is not None:
                X.append(fa); labels.append(c.label); orig.append(False)
    r = random.Random(1)
    neg = [P.features(c.x) for c in negs] + [P.features(x) for x in transitions(demo, 120, r) + idle(demo, r, 60)]
    neg = [f for f in neg if f is not None]
    E.MODELS.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(E.GENERIC, X=np.stack(X).astype(np.float16), labels=np.array(labels), orig=np.array(orig),
                        neg=np.stack(neg).astype(np.float16))
    generic = E.load_generic()
    model = P.train([], generic["neg"], sorted(set(P.VOCAB)) + [P.NONE], extra=generic)
    model.info.update({"profile": "demo", "own_reps": 0, "generic_clips": int(sum(orig)), "signers": len({c.signer for c in demo})})
    P.save(model, E.DEFAULT_MODEL)
    have = sorted({l for l in labels})
    print(f"{E.GENERIC.name}: {sum(orig)} clips of {len(have)} signs ({len({c.signer for c in demo})} signers) x {1 + P.AUG}, "
          f"{len(neg)} none; {E.DEFAULT_MODEL.name} fitted; {time.perf_counter() - t:.0f} s")
    missing = sorted(set(P.VOCAB) - set(have))
    if missing:
        print(f"no WLASL data for: {' '.join(missing)} (only enrolled reps will teach these)")


if __name__ == "__main__":
    main()
