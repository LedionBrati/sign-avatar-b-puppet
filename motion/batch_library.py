"""Batch the WLASL isolated-sign library into raw + clean motion files (resumable).

    uv run python batch_library.py --index C:/Users/DELL/Desktop/ai-summit/data/signs/index.json \
        --out-dir ../out/motion/wlasl --limit 20 --workers 4

Per sign: extract -> detect the dominant hand -> if left-dominant, re-extract with --mirror
(so every dictionary sign is right-dominant) -> clean with --trim-rest -> write
`<stem>.raw.json`, `<stem>.clean.json` and a row in `summary.csv`.

Resumable: a sign whose `rows/<stem>.json` exists is skipped (use --force to redo).
`--reclean` re-runs only the cleanup from the existing `.raw.json` files (seconds, no tracking), for
when clean.py settings change.
The library videos are read in place and never copied (WLASL licence C-UDA, non-commercial).
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

from common import ensure_model, motion_id_from_gloss, save_json

FIELDS = ["gloss", "motion_id", "name", "file", "signer", "frames", "fps", "dominant", "mirrored", "dominant_after_mirror",
          "left_pct", "right_pct", "dominant_hand_pct_clean", "trim_start", "trim_end", "trimmed_frames",
          "extract_s", "total_s", "error"]


def clean_and_fill_row(raw: dict, row: dict, out: Path, stem: str) -> None:
    from clean import clean_motion

    clean = clean_motion(raw, trim_rest=True)
    save_json(clean, out / f"{stem}.clean.json")
    a, b = clean["cleanup"]["trim"]
    dom = "rightHand" if (clean["dominant_hand"] or "right") == "right" else "leftHand"
    cf = clean["frames"]
    row.update(trim_start=a, trim_end=b, trimmed_frames=len(cf),
               dominant_hand_pct_clean=round(100 * sum(f[dom] is not None for f in cf) / max(len(cf), 1), 1))


def reclean_one(gloss: str, entry: dict, out_dir: str) -> dict:
    from common import load_json

    out = Path(out_dir)
    stem = Path(entry["file"]).stem
    row_path = out / "rows" / f"{stem}.json"
    row = json.loads(row_path.read_text(encoding="utf-8"))
    raw_path = out / f"{stem}.raw.json"
    if raw_path.exists():
        clean_and_fill_row(load_json(raw_path), row, out, stem)
        row_path.write_text(json.dumps(row), encoding="utf-8")
    return row


def process_one(gloss: str, entry: dict, lib_dir: str, out_dir: str) -> dict:
    from extract import extract_video

    t0 = time.perf_counter()
    video = Path(lib_dir) / entry["file"]
    stem = Path(entry["file"]).stem
    out = Path(out_dir)
    row = {k: "" for k in FIELDS}
    row.update(gloss=gloss, motion_id=motion_id_from_gloss(gloss), name=stem, file=entry["file"], signer=entry.get("signer_id", ""))
    try:
        meta = dict(name=stem, dataset="WLASL", license="C-UDA (non-commercial)",
                    signer=None if entry.get("signer_id") is None else str(entry["signer_id"]),
                    gloss=gloss.upper(), motion_id=motion_id_from_gloss(gloss), source_file=entry["file"])
        raw, st = extract_video(video, **meta)
        ext_s = st["seconds"]
        row["dominant"] = raw["dominant_hand"] or "unknown"
        if raw["dominant_hand"] == "left":
            raw, st2 = extract_video(video, mirror=True, **meta)
            ext_s += st2["seconds"]
            row["dominant_after_mirror"] = raw["dominant_hand"] or "unknown"
        n = len(raw["frames"])
        row.update(frames=n, fps=raw["fps"], mirrored=int(raw["mirrored"]),
                   left_pct=round(100 * sum(f["leftHand"] is not None for f in raw["frames"]) / max(n, 1), 1),
                   right_pct=round(100 * sum(f["rightHand"] is not None for f in raw["frames"]) / max(n, 1), 1))
        save_json(raw, out / f"{stem}.raw.json")
        row["extract_s"] = round(ext_s, 2)
        clean_and_fill_row(raw, row, out, stem)
    except Exception as e:  # keep going; the row records the error
        row["error"] = f"{type(e).__name__}: {e}"
        traceback.print_exc()
    row["total_s"] = round(time.perf_counter() - t0, 2)
    (out / "rows").mkdir(parents=True, exist_ok=True)
    (out / "rows" / f"{stem}.json").write_text(json.dumps(row), encoding="utf-8")
    return row


def write_summary(index: dict, out: Path) -> list[dict]:
    rows = []
    for gloss, entry in index.items():
        p = out / "rows" / f"{Path(entry['file']).stem}.json"
        if p.exists():
            rows.append(json.loads(p.read_text(encoding="utf-8")))
    with open(out / "summary.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--index", required=True, help="WLASL index.json (gloss -> {file, signer_id, source_url})")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--limit", type=int, help="only the first N signs of the index")
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--force", action="store_true", help="redo signs that already have a row")
    ap.add_argument("--reclean", action="store_true", help="only re-run cleanup on existing raw files")
    a = ap.parse_args(argv)

    index_path = Path(a.index)
    index = json.loads(index_path.read_text(encoding="utf-8"))
    lib_dir = index_path.parent
    out = Path(a.out_dir)
    (out / "rows").mkdir(parents=True, exist_ok=True)
    ensure_model()

    items = list(index.items())[: a.limit] if a.limit else list(index.items())
    if a.reclean:
        n = 0
        for g, e in items:
            if (out / "rows" / f"{Path(e['file']).stem}.json").exists():
                reclean_one(g, e, str(out))
                n += 1
        rows = write_summary(index, out)
        print(json.dumps({"recleaned": n, "rows_in_summary": len(rows)}))
        return
    todo = [(g, e) for g, e in items
            if a.force or not (out / "rows" / f"{Path(e['file']).stem}.json").exists()]
    print(f"{len(items)} signs selected, {len(items) - len(todo)} already done, {len(todo)} to do, "
          f"{a.workers} worker(s)", flush=True)
    t0 = time.perf_counter()
    done = 0
    if a.workers <= 1:
        results = (process_one(g, e, str(lib_dir), str(out)) for g, e in todo)
        for row in results:
            done += 1
            print(json.dumps({k: row[k] for k in ("gloss", "frames", "dominant", "mirrored", "trimmed_frames",
                                                    "total_s", "error")}), flush=True)
    else:
        with ProcessPoolExecutor(max_workers=a.workers) as ex:
            futs = [ex.submit(process_one, g, e, str(lib_dir), str(out)) for g, e in todo]
            for fut in as_completed(futs):
                row = fut.result()
                done += 1
                print(json.dumps({k: row[k] for k in ("gloss", "frames", "dominant", "mirrored", "trimmed_frames",
                                                        "total_s", "error")}), flush=True)
    wall = time.perf_counter() - t0
    rows = write_summary(index, out)
    if done:
        per = wall / done
        print(json.dumps({"done": done, "wall_s": round(wall, 1), "wall_s_per_sign": round(per, 2),
                          "estimate_all_h": round(per * len(index) / 3600, 2), "rows_in_summary": len(rows)}))


if __name__ == "__main__":
    sys.exit(main())
