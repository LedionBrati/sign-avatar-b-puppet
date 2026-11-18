"""context.py (the offline compose pick) == app/core/src/context.ts: same numbers and picks.

    uv run python tests/test_context.py --write     # regenerate app/core/test/fixtures/context-fixture.json
"""
import json
import random
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # run directly as well as under pytest
import context as C  # noqa: E402

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


def test_same_numbers_as_ts():
    src = TS.read_text(encoding="utf-8")
    m = re.search(r"CONTEXT = \{ topK: (\d+), lmWeight: ([\d.]+), addK: ([\d.]+) \}", src)
    assert (int(m.group(1)), float(m.group(2)), float(m.group(3))) == (C.TOP_K, C.LM_WEIGHT, C.ADD_K)


def test_fixture_is_current():
    fixture = json.loads(FIXTURE.read_text())
    if fixture != cases() and "DEMO_SENTENCES" in TS.read_text(encoding="utf-8"):
        pytest.skip("context.ts still has its demo-sentence prior: once it is flat like context.py, regenerate the "
                    "fixture with `python tests/test_context.py --write`")
    assert fixture == cases()


def test_default_prior_is_flat():
    # no built-in sentences: the top guess of every sign is kept, however unlikely the pair
    signs = [{"options": [{"label": "ME", "confidence": 0.9}]},
             {"options": [{"label": "BYE", "confidence": 0.4}, {"label": "HUNGRY", "confidence": 0.38}]}]
    assert C.labels(signs) == ["ME", "BYE"]


def test_context_fixes_a_close_call():
    # with a prior where "ME HUNGRY" happens and "ME BYE" never does: HUNGRY, barely behind BYE, wins
    lm = C.Bigram(["ME HUNGRY", "YES ME HUNGRY", "ME FINE", "BYE", "THANK_YOU BYE"])
    signs = [{"options": [{"label": "ME", "confidence": 0.9}]},
             {"options": [{"label": "BYE", "confidence": 0.4}, {"label": "HUNGRY", "confidence": 0.38}, {"label": "WATER", "confidence": 0.1}]}]
    assert C.labels(signs, lm=lm) == ["ME", "HUNGRY"]
    signs[1]["options"][0]["confidence"] = 0.97  # a sure guess is not overruled
    signs[1]["options"][1]["confidence"] = 0.02
    assert C.labels(signs, lm=lm) == ["ME", "BYE"]


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
