"""context.py (the offline compose prior) == app/core/src/context.ts: same sentences, numbers and picks.

    python tests/test_context.py --write     # regenerate app/core/test/fixtures/context-fixture.json
"""
import json
import random
import re
import sys
from pathlib import Path

import context as C

ROOT = Path(__file__).resolve().parents[3]
TS = ROOT / "app" / "core" / "src" / "context.ts"
FIXTURE = ROOT / "app" / "core" / "test" / "fixtures" / "context-fixture.json"
LABELS = ["HELLO", "YES", "NO", "PLEASE", "THANK_YOU", "WATER", "HUNGRY", "SICK", "HOME", "HELP", "NAME", "NICE", "MEET",
          "YOU", "ME", "WHERE", "FINE", "HAPPY", "BYE", "SORRY"]


def cases(n=60, seed=3):
    r = random.Random(seed)
    out = []
    for _ in range(n):
        signs = []
        for _ in range(r.randint(1, 5)):
            labs = r.sample(LABELS, r.randint(1, 5))
            conf = sorted((round(r.random(), 4) for _ in labs), reverse=True)
            s = {"options": [{"label": l, "confidence": c} for l, c in zip(labs, conf)]}
            if r.random() < 0.15:
                s.update(fixed=True, sel=r.randrange(len(labs)))
            signs.append(s)
        out.append({"signs": signs, "picked": C.pick(signs)})
    return out


def test_same_sentences_and_numbers_as_ts():
    src = TS.read_text(encoding="utf-8")
    block = re.search(r"DEMO_SENTENCES: readonly string\[\] = \[(.*?)\];", src, re.S).group(1)
    assert re.findall(r'"([A-Z_ ]+)"', block) == C.DEMO_SENTENCES
    m = re.search(r"CONTEXT = \{ topK: (\d+), lmWeight: ([\d.]+), addK: ([\d.]+) \}", src)
    assert (int(m.group(1)), float(m.group(2)), float(m.group(3))) == (C.TOP_K, C.LM_WEIGHT, C.ADD_K)


def test_fixture_is_current():
    assert json.loads(FIXTURE.read_text()) == cases()


def test_context_fixes_a_close_call():
    # ME is sure; HUNGRY is the 2nd guess, barely behind BYE: "ME BYE" never happens, "ME HUNGRY" does
    signs = [{"options": [{"label": "ME", "confidence": 0.9}]},
             {"options": [{"label": "BYE", "confidence": 0.4}, {"label": "HUNGRY", "confidence": 0.38}, {"label": "WATER", "confidence": 0.1}]}]
    assert C.labels(signs) == ["ME", "HUNGRY"]
    signs[1]["options"][0]["confidence"] = 0.97  # a sure guess is not overruled
    signs[1]["options"][1]["confidence"] = 0.02
    assert C.labels(signs) == ["ME", "BYE"]


def test_confident_guess_wins_and_fixed_is_kept():
    signs = [{"options": [{"label": "BYE", "confidence": 0.95}, {"label": "HELLO", "confidence": 0.03}]},
             {"options": [{"label": "NICE", "confidence": 0.9}, {"label": "MEET", "confidence": 0.05}]}]
    assert C.labels(signs) == ["BYE", "NICE"]
    signs[0].update(fixed=True, sel=1)
    assert C.labels(signs) == ["HELLO", "NICE"]
    assert C.pick([{"options": []}, signs[1]]) == [-1, 0]


if __name__ == "__main__" and "--write" in sys.argv:
    FIXTURE.write_text(json.dumps(cases()))
    print(f"wrote {FIXTURE}")
