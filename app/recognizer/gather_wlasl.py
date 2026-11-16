"""Gather every reachable WLASL instance of the demo signs (and one clip per other gloss, the open-set negatives) and
extract MediaPipe Holistic landmarks. Runs on Modal (modal_sign_eval.py::gather), never on the laptop.

    python gather_wlasl.py --jobs   --wlasl WLASL_v0.3.json --dict index.json        # -> GEN/jobs.json
    python gather_wlasl.py --run 0,40                                                # fetch + extract jobs[0:40]

Demo jobs: all instances of the demo glosses + variants (GLOSS_LABEL, plus "ill" = SICK, the same sign) from
WLASL_v0.3.json: direct links with urllib, YouTube with yt-dlp (both often dead: skipped after one try, the reason is
recorded). Negative jobs: one instance per other gloss (not NOT_NEGATIVE), the dictionary's own clip first, then
the other direct links of that gloss until one works. Frame ranges (1-based, inclusive, -1 = end) are applied before
extraction. Output (GEN, gitignored / private volume; landmarks are biometric, never committed or printed):
  GEN/videos/<sha1(url)>.<ext>   GEN/landmarks/<name>.npy (float16 [frames, 543, 3])   GEN/meta/<name>.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

GEN = Path(os.environ.get("GEN_DIR") or Path(__file__).resolve().parents[2] / "out" / "wlasl-gen")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"}
# WLASL gloss -> demo label (demo_data.GLOSS_LABEL + variants that are the same sign)
DEMO = {"hello": "HELLO", "yes": "YES", "no": "NO", "please": "PLEASE", "thank you": "THANK_YOU", "water": "WATER",
        "hungry": "HUNGRY", "sick": "SICK", "ill": "SICK", "home": "HOME", "help": "HELP", "name": "NAME", "nice": "NICE",
        "meet": "MEET", "you": "YOU", "me": "ME", "i": "ME", "where": "WHERE", "fine": "FINE", "happy": "HAPPY",
        "bye": "BYE", "goodbye": "BYE", "sorry": "SORRY"}
NOT_NEGATIVE = set(DEMO) | {"hi", "thanks", "my", "mine", "your", "welcome", "excuse", "apologize", "drink", "house",
                            "disease", "good", "glad", "cheerful", "introduce"}
MAX_W = 640  # frames wider than this are downscaled before MediaPipe (same landmarks in image coords, faster)


def _yt(url: str) -> bool:
    return "youtube" in url or "youtu.be" in url


def make_jobs(wlasl: Path, dict_index: Path | None) -> list[dict]:
    d = json.loads(wlasl.read_text(encoding="utf-8"))
    lib = json.loads(dict_index.read_text(encoding="utf-8")) if dict_index and dict_index.exists() else {}
    out = []
    for e in d:
        g = e["gloss"]
        ins = e["instances"]
        if g in DEMO:
            for i in ins:
                if Path(i["url"].split("?")[0]).suffix.lower() == ".swf":
                    continue
                out.append({"kind": "demo", "gloss": g, "label": DEMO[g], "name": f"{g.replace(' ', '_')}-{i['video_id']}",
                            "signer": str(i["signer_id"]), "source": i["source"], "urls": [i["url"]],
                            "frame_start": i["frame_start"], "frame_end": i["frame_end"], "fps": i["fps"]})
        elif g not in NOT_NEGATIVE and len(g) > 1:
            direct = [i for i in ins if not _yt(i["url"]) and not i["url"].lower().endswith(".swf")]
            first = lib.get(g, {}).get("source_url")
            direct.sort(key=lambda i: i["url"] != first)
            if not direct:
                continue
            i = direct[0]
            out.append({"kind": "neg", "gloss": g, "label": g, "name": f"neg-{g.replace(' ', '_').replace('/', '_')}",
                        "signer": str(i["signer_id"]), "source": i["source"],
                        "urls": [j["url"] for j in direct[:4]], "ranges": [[j["frame_start"], j["frame_end"], str(j["signer_id"])] for j in direct[:4]],
                        "frame_start": i["frame_start"], "frame_end": i["frame_end"], "fps": i["fps"]})
    return out


def fetch(url: str) -> tuple[Path | None, str]:
    h = hashlib.sha1(url.encode()).hexdigest()[:16]
    vd = GEN / "videos"
    vd.mkdir(parents=True, exist_ok=True)
    for p in vd.glob(f"{h}.*"):
        if p.stat().st_size > 10_000:
            return p, "cached"
    if _yt(url):
        dest = vd / f"{h}.mp4"
        try:
            p = subprocess.run([sys.executable, "-m", "yt_dlp", "-q", "--no-warnings", "--no-playlist", "-f",
                                "best[height<=480][ext=mp4]/best[height<=480]/best", "--socket-timeout", "20",
                                "-o", str(dest), url], capture_output=True, text=True, timeout=120)
            if dest.exists() and dest.stat().st_size > 10_000:
                return dest, "ok"
            return None, "yt: " + (p.stderr.strip().splitlines() or ["failed"])[-1][:120]
        except Exception as e:  # noqa: BLE001
            return None, f"yt: {type(e).__name__}"
    ext = Path(url.split("?")[0]).suffix.lower()
    ext = ext if ext in (".mp4", ".mov", ".m4v", ".webm", ".flv", ".mkv") else ".mp4"
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read(40_000_000)
        if len(data) < 10_000 or data[:15].lower().startswith((b"<!doctype", b"<html")):
            return None, "not a video"
        dest = vd / f"{h}{ext}"
        dest.write_bytes(data)
        return dest, "ok"
    except Exception as e:  # noqa: BLE001 - dead link
        return None, type(e).__name__




def _detector():
    from mediapipe.tasks.python import BaseOptions, vision

    task = os.environ.get("HOLISTIC_TASK")
    if not task:
        from eval_wlasl import holistic_model

        task = str(holistic_model())
    opts = vision.HolisticLandmarkerOptions(base_options=BaseOptions(model_asset_path=task),
                                            running_mode=vision.RunningMode.VIDEO)
    return vision.HolisticLandmarker.create_from_options(opts)


def extract(video: Path, a: int, b: int) -> tuple[np.ndarray, float]:
    """Frames [a-1, b) (WLASL 1-based inclusive; b = -1 -> end) -> float32 [frames, 543, 3], fps."""
    import cv2
    import mediapipe as mp

    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS)
    fps = float(fps) if fps and 5 <= fps <= 120 else 25.0
    lo, hi = max(0, a - 1), (b if b > 0 else 10 ** 9)
    if hi - lo > 1500:  # a long compilation without a usable range: skip
        hi = lo + 1500
    frames = []
    with _detector() as det:  # a fresh detector per clip: VIDEO mode needs increasing timestamps
        i, t = 0, 0
        while i < hi:
            ok, f = cap.read()
            if not ok:
                break
            if i >= lo:
                if f.shape[1] > MAX_W:
                    f = cv2.resize(f, (MAX_W, int(f.shape[0] * MAX_W / f.shape[1])), interpolation=cv2.INTER_AREA)
                img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(f, cv2.COLOR_BGR2RGB))
                res = det.detect_for_video(img, int(t * 1000 / fps))
                t += 1
                x = np.full((543, 3), np.nan, np.float32)
                for lms, start, n in ((res.face_landmarks, 0, 468), (res.left_hand_landmarks, 468, 21),
                                      (res.pose_landmarks, 489, 33), (res.right_hand_landmarks, 522, 21)):
                    for j, p in enumerate((lms or [])[:n]):
                        x[start + j] = (p.x, p.y, p.z)
                frames.append(x)
            i += 1
    cap.release()
    return (np.stack(frames) if frames else np.zeros((0, 543, 3), np.float32)), fps


def run_job(job: dict) -> dict:
    meta_p = GEN / "meta" / f"{job['name']}.json"
    if meta_p.exists():
        m = json.loads(meta_p.read_text())
        if m.get("ok") or not any(w.startswith("extract") for w in m.get("why", [])):
            return m  # done, or every link dead (an extraction error is retried: the video is cached)
    t = time.perf_counter()
    ranges = job.get("ranges") or [[job["frame_start"], job["frame_end"], job["signer"]]]
    why = []
    out = {k: job[k] for k in ("kind", "gloss", "label", "name", "source")}
    for url, (a, b, signer) in zip(job["urls"], ranges):
        vid, how = fetch(url)
        if vid is None:
            why.append(how)
            continue
        try:
            x, fps = extract(vid, a, b)
        except Exception as e:  # noqa: BLE001 - unreadable video
            why.append(f"extract: {type(e).__name__}: {str(e)[:160]}")
            continue
        hands = int(np.isfinite(x[:, [468, 522], 0]).any(1).sum()) if len(x) else 0
        if len(x) < 8 or hands < 4:
            why.append(f"no hands ({len(x)} frames, {hands} with hands)")
            continue
        (GEN / "landmarks").mkdir(parents=True, exist_ok=True)
        np.save(GEN / "landmarks" / f"{job['name']}.npy", x.astype(np.float16))
        out.update({"ok": True, "url": url, "signer": signer, "fps": fps, "frames": len(x), "hand_frames": hands,
                    "s": round(time.perf_counter() - t, 1)})
        break
    else:
        out.update({"ok": False, "why": why, "signer": job["signer"]})
    meta_p.parent.mkdir(parents=True, exist_ok=True)
    meta_p.write_text(json.dumps(out))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", action="store_true")
    ap.add_argument("--wlasl", type=Path)
    ap.add_argument("--dict", type=Path)
    ap.add_argument("--run", help="a,b: run jobs[a:b]")
    a = ap.parse_args()
    if a.jobs:
        js = make_jobs(a.wlasl, a.dict)
        GEN.mkdir(parents=True, exist_ok=True)
        (GEN / "jobs.json").write_text(json.dumps(js))
        print(f"{sum(j['kind'] == 'demo' for j in js)} demo instances, {sum(j['kind'] == 'neg' for j in js)} negative glosses")
    if a.run:
        lo, hi = map(int, a.run.split(","))
        js = json.loads((GEN / "jobs.json").read_text())[lo:hi]
        ok = 0
        for j in js:
            r = run_job(j)
            ok += bool(r.get("ok"))
        print(f"jobs {lo}-{hi}: {ok}/{len(js)} with landmarks")


if __name__ == "__main__":
    main()
