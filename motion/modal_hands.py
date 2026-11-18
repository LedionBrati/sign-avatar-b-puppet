"""Run the GPU hand model (WiLoR) + the anatomical fit over the sign library on Modal. Resumable.

Needs `pip install modal` and `modal setup`. Commands run from the repo root.

1. Upload motion files + videos to the volume (only what you will run; resumable, skips files
   already there):

    modal run motion/modal_hands.py::upload --only demo \
        --motion-dir out/motion/wlasl --signs-dir <signs>       # <signs> holds index.json and videos/

2. The owner's MANO model (free registration, non-commercial: https://mano.is.tue.mpg.de,
   "Models & Code", file mano_v1_2/models/MANO_RIGHT.pkl):

    modal volume put signlayer-hands <path>/MANO_RIGHT.pkl /mano/MANO_RIGHT.pkl

3. Run, then fetch:

    modal run motion/modal_hands.py --only demo --smoke      # 1 clip, dummy MANO: tests image + GPU, no hand data
    modal run motion/modal_hands.py --only demo              # the demo signs
    modal run motion/modal_hands.py                          # every sign uploaded
    modal volume get signlayer-hands /hands3d out/motion/wlasl3d

Per sign it writes /hands3d/<stem>.wilor.json (WiLoR joints + MANO params) and
/hands3d/<stem>.v2.json (FORMAT.md v2). A sign whose .v2.json exists is skipped, so a stopped run
continues where it left off (`--force` redoes it). Without MANO_RIGHT.pkl a real run stops with a
clear message. The WiLoR weights are public (Hugging Face) and are baked into the image.
"""
from __future__ import annotations

import json
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
WILOR_COMMIT = "fcb911312a38fa8badd30d9656a167485d61b8f9"  # rolpotamias/WiLoR main, checked 2026-11-16
HF = "https://huggingface.co/spaces/rolpotamias/WiLoR/resolve/main/pretrained_models"
GPU = "L4"  # ViT-L at 256x192: an L4 is plenty; the job is mostly video decode + crop preparation
VOLUME = "signlayer-hands"  # existing Modal volume (pre-rename name kept so cached data stays reachable)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "wget", "libgl1", "libglib2.0-0")
    .pip_install("torch==2.4.1", "torchvision==0.19.1", index_url="https://download.pytorch.org/whl/cu121")
    .pip_install("numpy==1.26.4", "scipy", "opencv-python-headless", "timm==0.9.16", "einops", "yacs",
                 "smplx==0.1.28", "pytorch-lightning==2.4.0", "scikit-image")
    # chumpy is only needed to unpickle the official MANO .pkl; its __init__ imports names that
    # numpy removed, so patch them out after installing.
    .run_commands("pip install --no-build-isolation git+https://github.com/mattloper/chumpy",
                  "sed -i 's/from numpy import bool, int, float, complex, object, unicode, str, nan, inf/"
                  "from numpy import nan, inf/' /usr/local/lib/python3.11/site-packages/chumpy/__init__.py")
    .run_commands(f"git clone https://github.com/rolpotamias/WiLoR.git /opt/WiLoR && cd /opt/WiLoR && git checkout {WILOR_COMMIT}",
                  f"wget -q -O /opt/WiLoR/pretrained_models/wilor_final.ckpt {HF}/wilor_final.ckpt")
    .add_local_dir(str(HERE), "/root/motion", ignore=[".venv", "models", "__pycache__", "tests", ".pytest_cache"])
)
vol = modal.Volume.from_name(VOLUME, create_if_missing=True)
app = modal.App("flux-hands", image=image)


@app.function(gpu=GPU, volumes={"/vol": vol}, timeout=3600, cpu=8.0, memory=16384)
def run_chunk(stems: list[str], force: bool = False, smoke: bool = False) -> list[dict]:
    import shutil
    import sys
    import time

    import torch

    sys.path.insert(0, "/root/motion")
    import hand_model  # noqa: F401  (pins BLAS threads)
    import hands3d
    import hands_gpu
    from common import load_json, save_json

    t_start = time.time()
    mano_dir = Path("/tmp/mano")
    mano_dir.mkdir(exist_ok=True)
    shutil.copy("/opt/WiLoR/mano_data/mano_mean_params.npz", mano_dir / "mano_mean_params.npz")
    if smoke:
        mano = "stub"
    else:
        if not Path("/vol/mano/MANO_RIGHT.pkl").exists():
            raise SystemExit("MANO_RIGHT.pkl missing on the volume: see step 2 in modal_hands.py")
        shutil.copy("/vol/mano/MANO_RIGHT.pkl", mano_dir / "MANO_RIGHT.pkl")
        mano = "official"
    model, cfg, vitdet, keys = hands_gpu.load_wilor("/opt/WiLoR", "/opt/WiLoR/pretrained_models/wilor_final.ckpt",
                                                    None, str(mano_dir), mano, "cuda")
    load_s = round(time.time() - t_start, 1)
    out = Path("/vol/smoke" if smoke else "/vol/hands3d")
    out.mkdir(exist_ok=True)
    rows = []
    for stem in stems:
        t0 = time.time()
        row = {"name": stem, "gpu": torch.cuda.get_device_name(0), "load_s": load_s}
        try:
            if (out / f"{stem}.v2.json").exists() and not force and not smoke:
                row["skipped"] = True
                rows.append(row)
                continue
            raw = load_json(f"/vol/motion/{stem}.raw.json")
            clean = load_json(f"/vol/motion/{stem}.clean.json")
            video = f"/vol/videos/{stem}.mp4"
            frames = hands_gpu.run_video(model, cfg, vitdet, raw, video, "cuda", batch=64)
            t1 = time.time()
            kp = {"model": "WiLoR wilor_final.ckpt" + (" (STUB MANO: joints meaningless)" if smoke else ""),
                  "mano": mano, "name": stem, "frames": frames}
            save_json(kp, out / f"{stem}.wilor.json")
            row.update(hands=sum(len(v) for v in frames.values()), wilor_s=round(t1 - t0, 1))
            if not smoke:
                v2, st = hands3d.build_v2(raw, clean, video, kp, redetect=False)
                save_json(v2, out / f"{stem}.v2.json")
                row.update(sources=st["sources"], fit_s=round(time.time() - t1, 1))
        except Exception as e:  # keep going; the row records the error
            row["error"] = f"{type(e).__name__}: {e}"
        row["seconds"] = round(time.time() - t0, 1)
        rows.append(row)
        vol.commit()
    return rows


def _select(index_path: str | None, only: str):
    import sys

    sys.path.insert(0, str(HERE))
    from batch_hands3d import select

    if index_path:
        idx = json.loads(Path(index_path).read_text(encoding="utf-8"))
    else:
        idx = json.loads(b"".join(vol.read_file("index.json")))
    return idx, select(idx, only or None, None)


@app.local_entrypoint()
def main(only: str = "", chunk: int = 40, force: bool = False, smoke: bool = False, index: str = ""):
    """--only demo | comma-separated glosses; default all signs uploaded. --smoke: 1 clip, dummy MANO."""
    import time

    _, items = _select(index or None, only)
    have = {e.path.split("/")[-1].removesuffix(".raw.json") for e in vol.listdir("/motion") if e.path.endswith(".raw.json")}
    stems = [Path(e["file"]).stem for g, e in items if Path(e["file"]).stem in have]
    if smoke:
        stems = stems[:1]
    chunks = [stems[k:k + chunk] for k in range(0, len(stems), chunk)]
    print(f"{len(stems)} signs in {len(chunks)} chunk(s) of <= {chunk} on {GPU}" + (" (smoke, stub MANO)" if smoke else ""))
    t0 = time.time()
    rows = [r for rs in run_chunk.map(chunks, kwargs={"force": force, "smoke": smoke}) for r in rs]
    done = [r for r in rows if not r.get("skipped") and not r.get("error")]
    for r in rows:
        print(json.dumps(r))
    print(json.dumps({"signs": len(rows), "done": len(done), "skipped": sum(1 for r in rows if r.get("skipped")),
                      "errors": sum(1 for r in rows if r.get("error")), "wall_s": round(time.time() - t0, 1)}))


@app.local_entrypoint()
def upload(motion_dir: str, signs_dir: str, only: str = ""):
    """Put <stem>.raw.json, <stem>.clean.json, videos/<stem>.mp4 and index.json on the volume."""
    md, sd = Path(motion_dir), Path(signs_dir)
    _, items = _select(str(sd / "index.json"), only)
    have = {e.path.split("/")[-1] for e in vol.listdir("/motion")} if _exists("/motion") else set()
    n = 0
    with vol.batch_upload(force=True) as b:
        b.put_file(str(sd / "index.json"), "/index.json")
        for g, e in items:
            stem = Path(e["file"]).stem
            if not (md / f"{stem}.raw.json").exists():
                continue
            if f"{stem}.raw.json" in have:
                continue
            b.put_file(str(md / f"{stem}.raw.json"), f"/motion/{stem}.raw.json")
            b.put_file(str(md / f"{stem}.clean.json"), f"/motion/{stem}.clean.json")
            b.put_file(str(sd / e["file"]), f"/videos/{stem}.mp4")
            n += 1
    print(f"uploaded {n} signs ({len(items)} selected) to volume {VOLUME}")


def _exists(path: str) -> bool:
    try:
        vol.listdir(path)
        return True
    except Exception:
        return False
