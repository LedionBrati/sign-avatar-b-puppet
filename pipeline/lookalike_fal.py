"""LTX 2.3 render-to-real (and a Recast 1080P control) on the lookalike signer renders. Paid; resumable.

    FAL_KEY=... python pipeline/lookalike_fal.py --out out/lookalike/fal --jobs ltx:demo3,ltx:lkb,ltx:lkc,recast:demo3

Every request id is appended to <out>/requests.jsonl BEFORE polling, so a rerun after a network drop polls the
same request instead of paying again. Outputs: <out>/<job>.mp4.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import time
import urllib.request
from pathlib import Path

import fal_client

PROMPT = ("3DREAL. Photorealistic studio video of a woman in her mid-30s with olive skin, brown eyes and a dark brown "
          "chin-length bob haircut, slightly side-parted, wearing a plain black long-sleeve crew-neck top, standing waist-up "
          "facing the camera in front of a plain dark grey wall with a fine vertical grain, soft even window light, "
          "signing in American Sign Language. Natural skin texture, real hands with five fingers each.")
LTX = "fal-ai/ltx-2.3-quality/render-to-real"
RECAST = "minimax/h3-max/recast"


def probe(f: Path) -> dict:
    j = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                                            "stream=nb_read_frames,r_frame_rate:format=duration", "-of", "json", str(f)]))
    n, d = map(int, j["streams"][0]["r_frame_rate"].split("/"))
    return {"frames": int(j["streams"][0]["nb_read_frames"]), "fps": n / d, "seconds": float(j["format"]["duration"])}


def ltx_frames(n: int) -> int:
    return min(481, max(9, math.ceil((n - 1) / 8) * 8 + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--renders", default="out/lookalike/renders")
    ap.add_argument("--jobs", default="ltx:demo3,ltx:lkb,ltx:lkc,recast:demo3")
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--first-frame", default="", help="image used as LTX frame 0 (identity anchor); empty = render only")
    ap.add_argument("--tag", default="", help="suffix for output names, e.g. -ff")
    ap.add_argument("--avatar", default="assets/avatar/avatar-main.jpg")
    ap.add_argument("--max-usd", type=float, default=3.0)
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    log = out / "requests.jsonl"
    done = {}
    if log.exists():
        for line in log.read_text().splitlines():
            r = json.loads(line); done[r["job"]] = r
    plan, total = [], 0.0
    for job in a.jobs.split(","):
        kind, stem = job.split(":")
        name = f"{kind}-{stem}{a.tag}"
        video = Path(a.renders) / f"{stem}-signer-bob.mp4"
        v = probe(video)
        if kind == "ltx":
            nf = ltx_frames(v["frames"])
            cost = 0.0024075 * math.ceil(720 * 960 * nf / 1e6)
        else:
            cost = 0.17 * max(5, v["seconds"]) + 0.022 * max(0, 6750 * v["seconds"] - 4096) / 1000
        plan.append((name, kind, video, v, cost))
        if name not in done:
            total += cost
    print(f"new spend planned: ${total:.3f}", [(p[0], round(p[4], 3)) for p in plan])
    if total > a.max_usd:
        raise SystemExit(f"over --max-usd {a.max_usd}")
    ff_url = fal_client.upload_file(a.first_frame) if a.first_frame and any(n not in done for n, *_ in plan) else None
    av_url = None
    for name, kind, video, v, cost in plan:
        if name in done:
            continue
        url = fal_client.upload_file(str(video))
        if kind == "ltx":
            inp = {"video_url": url, "prompt": PROMPT, "intensity": "strong-v2", "resolution": "720p",
                   "num_frames": ltx_frames(v["frames"]), "frames_per_second": round(v["fps"]), "enable_detail_refine": False,
                   "generate_audio": False, "seed": a.seed}
            if ff_url:
                inp["image_url"] = ff_url
            ep = LTX
        else:
            av_url = av_url or fal_client.upload_file(a.avatar)
            inp = {"video_url": url, "reference_image_urls": [av_url], "resolution": "1080P", "enable_safety_checker": True}
            ep = RECAST
        h = fal_client.submit(ep, arguments=inp)
        rec = {"job": name, "endpoint": ep, "request_id": h.request_id, "usd_est": round(cost, 3), "input": {k: v2 for k, v2 in inp.items() if k != "prompt"},
               "t": time.strftime("%Y-%m-%dT%H:%M:%S")}
        with log.open("a") as f:
            f.write(json.dumps(rec) + "\n")
        done[name] = rec
        print("submitted", name, h.request_id)
    for name, *_ in plan:
        r = done[name]
        dst = out / f"{name}.mp4"
        if dst.exists():
            continue
        while True:
            st = fal_client.status(r["endpoint"], r["request_id"])
            if type(st).__name__ == "Completed":
                break
            time.sleep(4)
        res = fal_client.result(r["endpoint"], r["request_id"])
        urllib.request.urlretrieve(res["video"]["url"], dst)
        (out / f"{name}.json").write_text(json.dumps({k: v for k, v in res.items() if k != "video"} | {"request_id": r["request_id"]}, indent=1))
        print("got", dst)


if __name__ == "__main__":
    main()
