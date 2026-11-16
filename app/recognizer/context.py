"""Python mirror of app/core/src/context.ts: pick, per sign, which of the top guesses to use so the whole run makes the
most sense, with an add-k bigram prior over the demo sentences. Same sentences and numbers (tests/test_context.py
checks the TS source and a shared fixture), so eval_generic.py measures what the web app does offline.

score(combination) = sum_i log(conf_i) + LM_WEIGHT * sum_i log P(label_i | label_{i-1})   (with <s> and </s>)
"""

from __future__ import annotations

import math
from collections import Counter

DEMO_SENTENCES = [
    "HELLO", "HELLO NICE MEET YOU", "HELLO ME NAME", "HELLO YOU FINE", "HELLO HAPPY MEET YOU", "NICE MEET YOU",
    "NICE MEET YOU BYE", "HAPPY MEET YOU", "YOU NAME", "ME NAME", "THANK_YOU", "THANK_YOU BYE", "THANK_YOU HELP",
    "YES", "YES PLEASE", "YES ME FINE", "YES ME HUNGRY", "YES THANK_YOU", "NO", "NO THANK_YOU", "NO ME FINE", "ME FINE",
    "ME FINE THANK_YOU", "ME HAPPY", "ME HUNGRY", "ME SICK", "ME SORRY", "SORRY", "SORRY ME SICK", "WATER PLEASE",
    "ME WATER PLEASE", "YOU WATER", "YOU HUNGRY", "YOU SICK", "YOU FINE", "YOU HAPPY", "HELP PLEASE", "HELP ME PLEASE",
    "PLEASE HELP ME", "HOME WHERE", "YOU HOME WHERE", "WATER WHERE", "ME HOME", "BYE", "BYE NICE MEET YOU",
    "ME HUNGRY WATER PLEASE", "ME SICK HELP PLEASE", "SORRY ME HOME",
]
TOP_K, LM_WEIGHT, ADD_K = 3, 0.5, 0.5
BOS, EOS = "<s>", "</s>"


class Bigram:
    def __init__(self, sentences=DEMO_SENTENCES, k: float = ADD_K):
        self.pair, self.ctx, vocab = Counter(), Counter(), {EOS}
        for s in sentences:
            w = [BOS, *s.split(), EOS]
            for a, b in zip(w, w[1:]):
                vocab.add(b)
                self.pair[(a, b)] += 1
                self.ctx[a] += 1
        self.k, self.v = k, len(vocab)

    def logp(self, prev: str, nxt: str) -> float:
        return math.log((self.pair[(prev, nxt)] + self.k) / (self.ctx[prev] + self.k * self.v))


DEFAULT_LM = Bigram()


def pick(signs: list[dict], lm: Bigram | None = None, lm_weight: float = LM_WEIGHT, top_k: int = TOP_K) -> list[int]:
    """signs: [{options: [{label, confidence}], fixed?, sel?}] -> per sign the option index (-1: no options)."""
    lm = lm or DEFAULT_LM
    prev = [(BOS, 0.0, [])]
    for s in signs:
        opts = s["options"]
        cand = ([s.get("sel", 0)] if opts[s.get("sel", 0):] else []) if s.get("fixed") else list(range(min(top_k, len(opts))))
        if not cand:
            prev = [(l, sc, b + [-1]) for l, sc, b in prev]
            continue
        nxt = []
        for i in cand:
            o = opts[i]
            emit = math.log(max(o["confidence"], 1e-4))
            best, bs = prev[0], -math.inf
            for q in prev:
                sc = q[1] + lm_weight * lm.logp(q[0], o["label"])
                if sc > bs:
                    bs, best = sc, q
            nxt.append((o["label"], bs + emit, best[2] + [i]))
        prev = nxt
    end, es = prev[0], -math.inf
    for q in prev:
        sc = q[1] + lm_weight * lm.logp(q[0], EOS)
        if sc > es:
            es, end = sc, q
    return end[2]


def labels(signs: list[dict], **kw) -> list[str]:
    return [s["options"][i]["label"] for s, i in zip(signs, pick(signs, **kw)) if i >= 0]
