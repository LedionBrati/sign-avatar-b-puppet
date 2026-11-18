"""Build models/templates.npz (the template-matching bank) from WLASL motion already extracted, no videos, no training.

    uv run python -m eval.build_templates            # build (~330 glosses, ~10 s, one process)
    uv run python -m eval.build_templates --eval     # + leave-one-out check on glosses with 2+ instances

Glosses = every sign the avatar can sign (realtime clip manifests) + the demo words below, where motion exists.
Gloss -> instance: the library index (data/signs/index.json) plus every other extracted instance of the same gloss
(e.g. all-a1, all-a3, have-a1..a3, nice-a1/a2, lucky-b1). Landmarks are biometric: the bank stores only the
derived hand features, and nothing is printed.

Inputs (flag or env; nothing machine-specific is assumed):
    --motion / MOTION_DIR       extracted WLASL motion (*.raw.json), default <repo>/out/motion/wlasl
    --index  / SIGN_DICTIONARY  the WLASL library index.json (required to build)
    CLIPS_DIR=dirA,dirB         realtime clip sets whose manifests add glosses, default <repo>/out/realtime/clips*
                                (a worktree without them falls back to the main checkout ../sign-avatar-b-puppet)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

import templates as T

REPO = Path(__file__).resolve().parents[3]
MOTION = Path(os.environ.get("MOTION_DIR") or REPO / "out" / "motion" / "wlasl")
INDEX = Path(os.environ["SIGN_DICTIONARY"]) if os.environ.get("SIGN_DICTIONARY") else None


def clip_dirs() -> list[Path]:
    if os.environ.get("CLIPS_DIR"):
        return [Path(d.strip()) for d in re.split(r"[,;]", os.environ["CLIPS_DIR"]) if d.strip()]
    realtime = REPO / "out" / "realtime"
    if not realtime.exists():
        realtime = REPO.parent / "sign-avatar-b-puppet" / "out" / "realtime"
    return [realtime / d for d in ("clips", "clips-demo", "clips-phrases", "clips-mass")]


MANIFESTS = [d / "manifest.json" for d in clip_dirs()]
NEEDED = ["HOW", "DAY", "GOOD", "EVENING", "I", "ME", "YOU", "YOUR", "SOME", "WANT", "BUILD", "COMPANY", "NICE", "MEET",
          "JUDGE", "LUCKY", "TODAY", "COFFEE", "ALL", "HAVE", "CAN", "WATER", "PLEASE", "HELLO", "THANK YOU", "WHERE",
          "BATHROOM", "NAME", "MY", "SEE", "LATER", "HELP", "SORRY", "YES", "NO", "MORNING", "WHAT", "LOVE", "TIRED",
          "SOON", "WEATHER", "DOCTOR", "HOSPITAL", "AFTERNOON", "NIGHT", "FINE", "FRIEND", "WORK", "SCHOOL", "EAT", "DRINK"]
ALIAS = {"LUCK": "LUCKY"}  # same sign; one label


def norm(gloss: str) -> str:
    """Gloss or stem prefix -> comparable key: 'THANK YOU' / 'thank_you' -> 'thank_you'."""
    return re.sub(r"[^a-z0-9]+", "_", gloss.lower()).strip("_")


def stem_key(stem: str) -> str:
    return norm(re.sub(r"-[^-]+$", "", stem))


def wanted_glosses() -> list[str]:
    g = set(NEEDED)
    for m in MANIFESTS:
        if m.exists():
            for k, v in json.loads(m.read_text()).items():
                g.add(str(v.get("gloss") or k).upper().replace("_", " "))
    return sorted({ALIAS.get(x, x) for x in g})


def instances(glosses: list[str]) -> dict[str, list[str]]:
    index = json.loads(INDEX.read_text())
    have = sorted(p.name[: -len(".raw.json")] for p in MOTION.glob("*.raw.json"))
    by_key = defaultdict(list)
    for s in have:
        by_key[stem_key(s)].append(s)
    out = {}
    for g in glosses:
        stems = set(by_key.get(norm(g), []))
        e = index.get(g.lower())
        if e:
            s = Path(e["file"]).stem
            if (MOTION / f"{s}.raw.json").exists():
                stems.add(s)
        if stems:
            out[g] = sorted(stems)
    return out


def load(stem: str) -> tuple[np.ndarray, bool]:
    raw = json.loads((MOTION / f"{stem}.raw.json").read_text())
    x = T.raw_to_frames(raw)
    dom = raw.get("dominant_hand")
    if dom is None:  # unknown: the hand seen in more frames
        dom = "left" if np.isfinite(x[:, T.LH, 0]).sum() > np.isfinite(x[:, T.RH, 0]).sum() else "right"
    return x, dom == "left"


def build(out: Path) -> dict:
    t = time.perf_counter()
    glosses = wanted_glosses()
    inst = instances(glosses)
    names, gidx, stems, feats = sorted(inst), [], [], []
    for gi, g in enumerate(names):
        for s in inst[g]:
            x, left = load(s)
            f = T.features(x, mirror=left)
            if f is None:
                continue
            gidx.append(gi)
            stems.append(s)
            feats.append(f)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, glosses=np.array(names), gloss_idx=np.array(gidx, np.int32), stems=np.array(stems),
                        feats=np.stack(feats).astype(np.float16))
    missing = [g for g in glosses if g not in inst]
    print(f"bank: {len(set(gidx))} glosses, {len(feats)} templates, {out.stat().st_size // 1024} KB, {time.perf_counter() - t:.0f} s -> {out}")
    print(f"no extracted motion for {len(missing)}: {' '.join(missing)}")
    need_missing = [g for g in NEEDED if ALIAS.get(g, g) not in inst]
    if need_missing:
        print(f"NEEDED but missing: {need_missing}")
    return inst


def evaluate(path: Path, with_gislr: bool) -> None:
    """Leave-one-out: every instance of a gloss with 2+ instances is a query against the bank minus itself."""
    bank = T.TemplateBank(path)
    by_gloss = defaultdict(list)
    for s, gi in zip(bank.stems, bank.gloss_idx):
        by_gloss[bank.glosses[gi]].append(s)
    queries = [(g, s) for g, ss in by_gloss.items() if len(ss) > 1 for s in ss]
    rec = None
    if with_gislr:
        from eval.eval_wlasl import hands_window
        from recognizer import Recognizer
        rec = Recognizer(spell=False, templates=False)  # GISLR only; the templates come from the leave-one-out bank
    hit1 = hit5 = m1 = m5 = 0
    ms, d_ok, d_bad = [], [], []
    for g, s in queries:
        x, _ = load(s)  # as the web would send it: unmirrored, all 543 points
        t = time.perf_counter()
        d = bank.distances(x, exclude={s})
        opts = T.scores_to_options(d, bank.glosses, 5)
        ms.append((time.perf_counter() - t) * 1000)
        labels = [o["label"] for o in opts]
        want = T.gloss_label(g)
        hit1 += labels[:1] == [want]
        hit5 += want in labels
        d_ok.append(float(d[bank.glosses.index(g)]))
        d_bad.append(float(np.min(np.where(np.arange(len(d)) == bank.glosses.index(g), np.inf, d))))
        rank = labels.index(want) + 1 if want in labels else "-"
        line = f"  {s:<22} {g:<10} rank {rank}  top: {', '.join(f'{o['text']} {o['confidence']:.2f}' for o in opts[:3])}"
        if rec is not None:
            gis = rec.recognize("sign", hands_window(x))["options"]
            merged = T.merge(gis, opts)
            texts = [o["text"] for o in merged]
            m1 += texts[:1] == [T.gloss_text(g)]
            m5 += T.gloss_text(g) in texts
            line += f" | merged: {', '.join(f'{o['text']} {o['confidence']:.2f}' for o in merged[:3])}"
        print(line)
    n = len(queries)
    print(f"\ntemplates only: top-1 {hit1}/{n} ({hit1 / n:.0%}), top-5 {hit5}/{n} ({hit5 / n:.0%}); "
          f"match {np.median(ms):.1f} ms median, {max(ms):.1f} max, {len(bank.feats)} templates")
    if rec is not None:
        print(f"merged with GISLR: top-1 {m1}/{n} ({m1 / n:.0%}), top-5 {m5}/{n} ({m5 / n:.0%})")
    print(f"distance correct gloss: median {np.median(d_ok):.3f}; best wrong gloss: median {np.median(d_bad):.3f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=T.BANK_PATH)
    ap.add_argument("--eval", action="store_true", help="leave-one-out check after building")
    ap.add_argument("--eval-only", action="store_true")
    ap.add_argument("--gislr", action="store_true", help="also report the merged GISLR + template top-5")
    ap.add_argument("--motion", type=Path, help="extracted motion dir (default MOTION_DIR or <repo>/out/motion/wlasl)")
    ap.add_argument("--index", type=Path, help="WLASL library index.json (default SIGN_DICTIONARY)")
    a = ap.parse_args()
    global MOTION, INDEX
    MOTION, INDEX = a.motion or MOTION, a.index or INDEX
    if not a.eval_only:
        if not MOTION.exists():
            sys.exit(f"no motion at {MOTION} (set --motion or MOTION_DIR)")
        if not INDEX or not INDEX.exists():
            sys.exit(f"no library index at {INDEX} (set --index or SIGN_DICTIONARY to the WLASL index.json)")
        build(a.out)
    if a.eval or a.eval_only:
        evaluate(a.out, a.gislr)


if __name__ == "__main__":
    main()
