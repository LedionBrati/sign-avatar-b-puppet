"""Download more WLASL instances (different signers) of the demo vocabulary, for the enrollment / segmentation eval.

    .venv/Scripts/python fetch_wlasl_demo.py --wlasl <path-to>/WLASL_v0.3.json         # -> out/wlasl-demo/
    .venv/Scripts/python fetch_wlasl_demo.py --wlasl ... --extract                      # + landmarks (MediaPipe, CPU)

Only direct video links (no YouTube); dead links are skipped after one try (15 s timeout). Nothing is paid.
Clips with frame_start/frame_end keep only that part when landmarks are extracted. Output (gitignored, WLASL is
research use only): out/wlasl-demo/videos/<gloss>-<video_id>.<ext>, out/wlasl-demo/index.json (gloss, signer,
source, frames), out/wlasl-demo/landmarks/<name>.npy (legacy 543 x 3 layout, biometric: never committed).
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OUT = REPO / "out" / "wlasl-demo"
# Demo vocabulary (finals): WLASL gloss -> our label.
DEMO = {"hello": "HELLO", "yes": "YES", "no": "NO", "please": "PLEASE", "thank you": "THANK_YOU", "water": "WATER",
        "hungry": "HUNGRY", "sick": "SICK", "home": "HOME", "help": "HELP", "name": "NAME", "nice": "NICE",
        "meet": "MEET", "you": "YOU", "me": "ME", "i": "ME", "where": "WHERE", "fine": "FINE", "happy": "HAPPY",
        "bye": "BYE", "goodbye": "BYE", "sorry": "SORRY"}
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"}


def fetch(job: dict) -> dict:
    dest = OUT / "videos" / job["file"]
    if dest.exists() and dest.stat().st_size > 10_000:
        return {**job, "ok": True}
    try:
        req = urllib.request.Request(job["url"], headers=UA)
        with urllib.request.urlopen(req, timeout=15) as r:  # a bad certificate counts as a dead link
            data = r.read(30_000_000)
        if len(data) < 10_000 or data[:15].lower().startswith((b"<!doctype", b"<html")):
            return {**job, "ok": False, "why": "not a video"}
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return {**job, "ok": True}
    except Exception as e:  # noqa: BLE001 - dead link, skip
        return {**job, "ok": False, "why": type(e).__name__}


def jobs(wlasl: Path) -> list[dict]:
    out = []
    for e in json.loads(wlasl.read_text()):
        g = e["gloss"]
        if g not in DEMO:
            continue
        for i in e["instances"]:
            url = i["url"]
            if "youtube" in url or "youtu.be" in url:
                continue
            ext = Path(url.split("?")[0]).suffix.lower()
            ext = ext if ext in (".mp4", ".mov", ".m4v", ".webm", ".swf", ".flv") else ".mp4"
            if ext == ".swf":
                continue
            out.append({"gloss": g, "label": DEMO[g], "video_id": i["video_id"], "signer": i["signer_id"], "source": i["source"],
                        "url": url, "frame_start": i["frame_start"], "frame_end": i["frame_end"], "fps": i["fps"],
                        "file": f"{g.replace(' ', '_')}-{i['video_id']}{ext}"})
    return out


def extract_all(index: list[dict], workers: int) -> None:
    from concurrent.futures import ProcessPoolExecutor

    from eval_wlasl import holistic_model

    model = holistic_model()
    todo = [(e, str(model)) for e in index if not (OUT / "landmarks" / f"{Path(e['file']).stem}.npy").exists()]
    print(f"extracting {len(todo)} clips with {workers} processes", flush=True)
    t = time.perf_counter()
    with ProcessPoolExecutor(workers) as ex:
        for n, name in enumerate(ex.map(_extract_job, todo), 1):
            if n % 10 == 0:
                print(f"  {n}/{len(todo)} ({time.perf_counter() - t:.0f} s)", flush=True)


def _extract_job(args) -> str:
    e, model = args
    from eval_wlasl import extract

    x = extract(OUT / "videos" / e["file"], Path(model))
    a, b = e["frame_start"], e["frame_end"]
    if a > 1 or b > 0:  # WLASL frame numbers are 1-based, inclusive; -1 = to the end
        x = x[max(0, a - 1): (b if b > 0 else len(x))]
    p = OUT / "landmarks" / f"{Path(e['file']).stem}.npy"
    p.parent.mkdir(parents=True, exist_ok=True)
    np.save(p, x.astype(np.float16))
    return p.name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wlasl", type=Path, default=os.environ.get("WLASL_JSON"), help="WLASL_v0.3.json")
    ap.add_argument("--extract", action="store_true")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    a = ap.parse_args()
    js = jobs(a.wlasl)
    print(f"{len(js)} direct links for {len(DEMO)} glosses", flush=True)
    t = time.perf_counter()
    with ThreadPoolExecutor(16) as ex:
        res = list(ex.map(fetch, js))
    ok = [r for r in res if r["ok"]]
    print(f"downloaded {len(ok)}/{len(res)} in {time.perf_counter() - t:.0f} s", flush=True)
    index = [{k: v for k, v in r.items() if k not in ("ok", "why")} for r in ok]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "index.json").write_text(json.dumps(index, indent=1))
    by = {}
    for r in ok:
        by.setdefault(r["label"], set()).add(r["signer"])
    print(" ".join(f"{k}:{len(v)}" for k, v in sorted(by.items())))
    if a.extract:
        extract_all(index, a.workers)


if __name__ == "__main__":
    main()
