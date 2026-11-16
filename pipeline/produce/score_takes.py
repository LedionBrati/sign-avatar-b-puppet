"""Finger score per sign segment for every take of one batch (motion/finger_fidelity.py maths), for produce.mjs.

    python score_takes.py --ref PUPPET.mp4 --motion BATCH.clean.json --segments BATCH.json --take 0=T0.mp4 --take 1=T1.mp4

Per take and per sign segment (gloss != null): the generated video against
- the source hands (`vs_motion`: the composed motion the puppet was driven by; frame i of the motion = frame i of the
  video), which is what produce.mjs ranks takes by (handshape changes first, then joint error), and
- the puppet render (`vs_ref`), incl. how often a hand the puppet shows is lost in the take (drop %).
Runs on Modal (pipeline/produce/modal_post.py): MediaPipe on 1080P video is too heavy for the laptop.
Prints one JSON object.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
for cand in (HERE.parent.parent / "motion", Path("/root/motion")):
    if (cand / "finger_fidelity.py").exists():
        sys.path.insert(0, str(cand))
        break
import finger_fidelity as ff  # noqa: E402


def _drop_per_sign(cmp: dict, signs: list) -> list:
    f = cmp["_frame"]
    out = []
    for s in signs:
        sl = slice(s["start"], s["end"] + 1)
        r, g = f["det_r"][sl], f["det_g"][sl]
        n = int(r.sum())
        out.append(ff._r(100 * (r & ~g).sum() / n) if n else None)
    return out


def _sub(row: dict) -> dict:
    return {k: row.get(k) for k in ("mean_joint_err_deg", "handshape_change_pct", "hand_frames_scored")}


def score(ref: str, motion: str | None, segments: list, takes: list[tuple[int, str]], landmarks=ff.landmarks) -> dict:
    """takes: [(k, video path)]. `landmarks` is injectable for tests."""
    ref_d = landmarks(ref)
    n = len(ref_d["x543"])
    mask, signs = ff.sign_mask(n, segments)
    mo = None
    if motion and Path(motion).exists():
        mo = ff.from_motion(motion)
        mo["fps"] = ref_d["fps"]
    out = {"ref": ref, "ref_frames": n, "signs": [s["gloss"] for s in signs], "takes": []}
    for k, path in takes:
        gen = landmarks(path)
        c_rg = ff.compare(ref_d, gen, mask)
        rows_rg = ff.segment_scores(c_rg, signs)
        drops = _drop_per_sign(c_rg, signs)
        row = {"k": k, "video": path, "frames": len(gen["x543"]), "all": {"vs_ref": ff.strip_private(c_rg)["all"]}, "per_sign": []}
        rows_mg = [None] * len(signs)
        if mo is not None:
            mm = np.zeros(len(mo["x543"]), bool)
            m = min(len(mm), len(mask))
            mm[:m] = mask[:m]
            c_mg = ff.compare(mo, gen, mm)
            row["all"]["vs_motion"] = ff.strip_private(c_mg)["all"]
            rows_mg = ff.segment_scores(c_mg, signs)
        for i, s in enumerate(signs):
            vs_ref = {**_sub(rows_rg[i]), "drop_pct": drops[i]}
            row["per_sign"].append({"index": i, "gloss": s["gloss"], "start": s["start"], "end": s["end"],
                                    "vs_ref": vs_ref, "vs_motion": _sub(rows_mg[i]) if rows_mg[i] else None})
        out["takes"].append(row)
    return out


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--motion")
    ap.add_argument("--segments", required=True, help="JSON file with {segments: [...]}")
    ap.add_argument("--take", action="append", default=[], help="K=path.mp4 (repeat)")
    a = ap.parse_args(argv)
    segs = json.loads(Path(a.segments).read_text(encoding="utf-8"))["segments"]
    takes = [(int(t.split("=", 1)[0]), t.split("=", 1)[1]) for t in a.take]
    print(json.dumps(score(a.ref, a.motion, segs, takes)))


if __name__ == "__main__":
    main()
