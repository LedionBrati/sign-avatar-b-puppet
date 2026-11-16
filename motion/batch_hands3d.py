"""Batch `hands3d.py` over the WLASL motion library (resumable). CPU; GPU keypoints optional.

    uv run python batch_hands3d.py --index <signs>/index.json --motion-dir ../out/motion/wlasl \
        --out-dir ../out/hands3d --only demo --workers 4
    # all signs: drop --only.  With GPU joints: --keypoints-dir <dir with <stem>.wilor.json>

Per sign: `<stem>.raw.json` + `<stem>.clean.json` (from batch_library.py) + the video (for
re-detection) -> `<stem>.v2.json` and a row in `summary.csv` (detection, impossible poses, jitter).
A sign whose `rows/<stem>.json` exists is skipped (`--force` redoes it). Videos are read in place.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

# The demo vocabulary (glosses as in WLASL's index.json).
DEMO = ["hello", "nice", "meet", "you", "where", "hurt", "need", "water", "please", "thank you", "thankyou",
        "see", "later", "yes", "no", "hungry", "sick", "home", "fine", "happy", "bye"]

FIELDS = ["gloss", "name", "frames", "dominant", "src_holistic", "src_redetect", "src_wilor", "src_filled",
          "detected_raw_pct", "detected_v2_pct", "impossible_raw_pct", "impossible_v2_pct",
          "angle_jitter_raw", "angle_jitter_v2", "motion_kept", "fit_mm_p50", "seconds", "error"]


def process_one(gloss: str, entry: dict, lib_dir: str, motion_dir: str, out_dir: str,
                keypoints_dir: str | None, redetect: bool) -> dict:
    import hand_model  # noqa: F401  (pins BLAS threads before numpy)
    import hands3d
    import hands_report
    from common import load_json, save_json

    t0 = time.perf_counter()
    stem = Path(entry["file"]).stem
    out = Path(out_dir)
    row = {k: "" for k in FIELDS}
    row.update(gloss=gloss, name=stem)
    try:
        raw = load_json(Path(motion_dir) / f"{stem}.raw.json")
        clean = load_json(Path(motion_dir) / f"{stem}.clean.json")
        kp = None
        if keypoints_dir:
            kp_path = Path(keypoints_dir) / f"{stem}.wilor.json"
            kp = load_json(kp_path) if kp_path.exists() else None
            if kp is not None and kp.get("mano") == "stub":
                kp = None
        video = Path(lib_dir) / entry["file"]
        v2, st = hands3d.build_v2(raw, clean, str(video) if video.exists() else None, kp, redetect)
        save_json(v2, out / f"{stem}.v2.json")
        side = v2.get("dominant_hand") or "right"
        rep = hands_report.report(raw, clean, v2)["sides"].get(side, {})
        src = rep.get("sources", {})
        pr = rep.get("raw_vs_v2", {})
        row.update(frames=len(v2["frames"]), dominant=side,
                   src_holistic=src.get("holistic", 0), src_redetect=src.get("redetect", 0),
                   src_wilor=src.get("wilor", 0), src_filled=src.get("filled", 0),
                   detected_raw_pct=rep.get("raw", {}).get("detected_pct"),
                   detected_v2_pct=rep.get("v2", {}).get("detected_pct"),
                   impossible_raw_pct=rep.get("raw", {}).get("impossible_pct"),
                   impossible_v2_pct=rep.get("v2", {}).get("impossible_pct"),
                   angle_jitter_raw=(pr.get("a") or {}).get("angle_jitter_deg"),
                   angle_jitter_v2=(pr.get("b") or {}).get("angle_jitter_deg"),
                   motion_kept=pr.get("motion_kept"),
                   fit_mm_p50=(rep.get("fit_mm_p50_p90") or [None])[0])
    except Exception as e:  # keep going; the row records the error
        row["error"] = f"{type(e).__name__}: {e}"
        traceback.print_exc()
    row["seconds"] = round(time.perf_counter() - t0, 2)
    (out / "rows").mkdir(parents=True, exist_ok=True)
    (out / "rows" / f"{stem}.json").write_text(json.dumps(row), encoding="utf-8")
    return row


def select(index: dict, only: str | None, limit: int | None) -> list[tuple[str, dict]]:
    items = list(index.items())
    if only == "demo":
        items = [(g, e) for g, e in items if g.lower() in DEMO]
    elif only:
        want = {w.strip().lower() for w in only.split(",")}
        items = [(g, e) for g, e in items if g.lower() in want]
    return items[:limit] if limit else items


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--index", required=True)
    ap.add_argument("--motion-dir", required=True, help="folder with <stem>.raw.json and <stem>.clean.json")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--keypoints-dir", help="folder with <stem>.wilor.json from hands_gpu.py / modal_hands.py")
    ap.add_argument("--only", help="'demo' or a comma-separated gloss list")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--no-redetect", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    index_path = Path(a.index)
    index = json.loads(index_path.read_text(encoding="utf-8"))
    out = Path(a.out_dir)
    (out / "rows").mkdir(parents=True, exist_ok=True)
    items = [(g, e) for g, e in select(index, a.only, a.limit)
             if (Path(a.motion_dir) / f"{Path(e['file']).stem}.raw.json").exists()]
    todo = [(g, e) for g, e in items if a.force or not (out / "rows" / f"{Path(e['file']).stem}.json").exists()]
    print(f"{len(items)} signs with motion, {len(items) - len(todo)} done, {len(todo)} to do", flush=True)
    args = (str(index_path.parent), a.motion_dir, str(out), a.keypoints_dir, not a.no_redetect)
    t0 = time.perf_counter()
    if a.workers <= 1:
        for g, e in todo:
            r = process_one(g, e, *args)
            print(json.dumps({k: r[k] for k in ("gloss", "impossible_raw_pct", "impossible_v2_pct", "seconds", "error")}), flush=True)
    else:
        with ProcessPoolExecutor(max_workers=a.workers) as ex:
            for fut in as_completed([ex.submit(process_one, g, e, *args) for g, e in todo]):
                r = fut.result()
                print(json.dumps({k: r[k] for k in ("gloss", "impossible_raw_pct", "impossible_v2_pct", "seconds", "error")}), flush=True)
    rows = [json.loads((out / "rows" / f"{Path(e['file']).stem}.json").read_text(encoding="utf-8"))
            for g, e in items if (out / "rows" / f"{Path(e['file']).stem}.json").exists()]
    with open(out / "summary.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    if todo:
        wall = time.perf_counter() - t0
        print(json.dumps({"done": len(todo), "wall_s": round(wall, 1), "s_per_sign": round(wall / len(todo), 2),
                          "estimate_all_h": round(wall / len(todo) * len(index) / 3600, 2)}))


if __name__ == "__main__":
    sys.exit(main())
