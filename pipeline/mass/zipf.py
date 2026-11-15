"""Spoken-English frequency for sign glosses (used by pipeline/mass/mass.mjs rank).

    uv run --no-project --with wordfreq python pipeline/mass/zipf.py < glosses.json > zipf.json

stdin: JSON list of glosses. stdout: {gloss: {"zipf": float, "parts": {word: zipf}}}.
Zipf scale (wordfreq, English, "best" wordlist = spoken + written mix): 7 ~ "the", 3 ~ rare.
A multiword gloss ("thank you", "hard of hearing") scores the MIN of its words: a phrase is
never more frequent than its rarest word, and this keeps "ice cream" below "ice".
"""
import json
import sys

from wordfreq import zipf_frequency

glosses = json.load(sys.stdin)
out = {}
for g in glosses:
    words = [w for w in g.lower().replace("_", " ").split() if w]
    parts = {w: zipf_frequency(w, "en") for w in words}
    out[g] = {"zipf": round(min(parts.values()) if parts else 0.0, 3), "parts": parts}
json.dump(out, sys.stdout)
