"""Run the heavy sign -> voice evals on Modal (CPU containers), so the laptop only edits and tests. Resumable.

Needs `pip install modal` and `modal setup`. Commands run from the repo root. Nothing here is paid beyond Modal
compute (CPU only, a few minutes); the recognizer itself stays local and free.

1. Upload the eval data (out/wlasl-demo caches from demo_data.py + fetch_wlasl_demo.py, the downloaded clips, and the
   library clips of the demo signs for the extractor check; skips what is already there):

    modal run app/recognizer/modal_sign_eval.py::upload --signs-dir <signs>     # <signs> holds index.json + videos/

2. Run (each job is its own container; logs land on the volume and print here):

    modal run app/recognizer/modal_sign_eval.py --smoke                  # 2 folds / 4 sentences: tests the image, a few min
    modal run app/recognizer/modal_sign_eval.py --jobs isolated,continuous
    modal run app/recognizer/modal_sign_eval.py --jobs rtmw              # RTMW whole-body on every demo clip, then
                                                                         # eval_demo.py extractor (MediaPipe vs RTMW)
    modal volume get signlayer-signeval /logs out/wlasl-demo/modal-logs

The code and the models (models/ minus the 41 MB fingerspelling model) are baked into the image from this checkout,
so run it after the code you want measured is in place. Landmarks are biometric: they stay on the private volume,
logs hold labels and scores only.
"""
from __future__ import annotations

import os
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1] if len(HERE.parents) > 1 else HERE  # in the container the file sits at /root
VOLUME = "signlayer-signeval"
DEMO = "/vol/wlasl-demo"  # DEMO_DIR inside the container
LIB = "/vol/lib"  # SIGN_LIB: index.json + videos/ of the demo signs
# demo_data.GLOSS_LABEL's keys (repeated so the upload runs without numpy in the Modal CLI's Python)
DEMO_GLOSSES = ["hello", "yes", "no", "please", "thank you", "water", "hungry", "sick", "home", "help", "name", "nice",
                "meet", "you", "me", "i", "where", "fine", "happy", "bye", "goodbye", "sorry"]

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("libgl1", "libglib2.0-0", "libegl1", "libgles2", "libgl1-mesa-dri")
    .pip_install("numpy>=1.26,<3", "ai-edge-litert>=2.0", "opencv-python-headless", "rtmlib==0.0.16", "onnxruntime",
                 "mediapipe==1.2.3", "yt-dlp")
    .run_commands("python -c \"import urllib.request as u; u.urlretrieve('https://storage.googleapis.com/mediapipe-models/holistic_landmarker/'"
                  "'holistic_landmarker/float16/latest/holistic_landmarker.task', '/opt/holistic_landmarker.task')\"")
    # RTMW weights (rtmlib downloads them on first use): bake them in so containers do not each fetch them
    .run_commands("python -c \"from rtmlib import Wholebody; Wholebody(mode='lightweight', backend='onnxruntime', device='cpu')\"")
    .add_local_dir(str(HERE), "/root/recognizer", ignore=[".venv", "__pycache__", ".pytest_cache", "models/fs.tflite"])
)
vol = modal.Volume.from_name(VOLUME, create_if_missing=True)
app = modal.App("signlayer-signeval", image=image)
GEN = "/vol/wlasl-gen"  # gather_wlasl.py output: every reachable WLASL instance of the demo signs + negatives
ENV = {"DEMO_DIR": DEMO, "SIGN_LIB": LIB, "GEN_DIR": GEN, "HOLISTIC_TASK": "/opt/holistic_landmarker.task", "OPENBLAS_NUM_THREADS": "8", "OMP_NUM_THREADS": "8", "PYTHONUNBUFFERED": "1"}


def _run(args: list[str], log: str) -> str:
    """python <args> in the recognizer folder; stdout + stderr (minus TFLite / MediaPipe noise) -> /vol/logs/<log>."""
    import subprocess
    import sys

    p = subprocess.run([sys.executable, *args], cwd="/root/recognizer", env={**os.environ, **ENV},
                       capture_output=True, text=True)
    out = "\n".join(l for l in (p.stdout + p.stderr).splitlines() if not l.startswith(("W0000", "I0000", "INFO:")))
    Path("/vol/logs").mkdir(parents=True, exist_ok=True)
    Path(f"/vol/logs/{log}").write_text(out + f"\n[exit {p.returncode}]\n")
    vol.commit()
    return out


@app.function(volumes={"/vol": vol}, cpu=8.0, memory=16384, timeout=3 * 3600)
def evaluate(what: str, smoke: bool = False) -> str:
    """eval_demo.py isolated | continuous | extractor (the latter after rtmw_chunk has filled /vol/wlasl-demo/rtmw-*)."""
    vol.reload()
    if what == "extractor":
        return _run(["eval_demo.py", "extractor", "--rtmw", f"{DEMO}/rtmw-lightweight-s2", "--stride", "2"], "extractor.log")
    args = ["eval_demo.py", what] + (["--smoke"] if smoke else [])
    return _run(args, f"{what}{'-smoke' if smoke else ''}.log")


@app.function(volumes={"/vol": vol}, cpu=4.0, memory=8192, timeout=3 * 3600)
def rtmw_chunk(names: list[str]) -> str:
    """RTMW whole-body (rtmlib lightweight, onnxruntime CPU) on these clips, every 2nd frame, into the volume."""
    vol.reload()
    return _run(["extract_rtmw.py", "--mode", "lightweight", "--stride", "2", "--only", ",".join(names)], f"rtmw-{names[0]}.log")


@app.function(volumes={"/vol": vol}, timeout=600)
def list_clips() -> list[str]:
    import subprocess
    import sys

    vol.reload()
    p = subprocess.run([sys.executable, "extract_rtmw.py", "--list"], cwd="/root/recognizer", env={**os.environ, **ENV},
                       capture_output=True, text=True, check=True)
    return [n for n in p.stdout.strip().split(",") if n]


@app.local_entrypoint()
def main(jobs: str = "isolated,continuous", smoke: bool = False, chunk: int = 6):
    """--jobs isolated,continuous,rtmw (rtmw = extraction in chunks, then the extractor comparison). --smoke: tiny runs."""
    want = [j.strip() for j in jobs.split(",") if j.strip()]
    if smoke:
        print(evaluate.remote("isolated", smoke=True))
        print(evaluate.remote("continuous", smoke=True))
        return
    calls = {j: evaluate.spawn(j) for j in want if j in ("isolated", "continuous")}
    if "rtmw" in want:
        names = list_clips.remote()
        parts = [names[k:k + chunk] for k in range(0, len(names), chunk)]
        print(f"RTMW: {len(names)} clips in {len(parts)} containers")
        for out in rtmw_chunk.map(parts):
            print(out.strip().splitlines()[-1] if out.strip() else "(no output)")
        print(evaluate.remote("extractor"))
    for j, c in calls.items():
        print(f"\n===== {j} =====\n{c.get()}")


@app.local_entrypoint()
def upload(signs_dir: str, demo_dir: str = ""):
    """out/wlasl-demo/{index.json, cache-*.npz, videos/} and the library clips of the demo signs -> the volume."""
    import json

    dd = Path(demo_dir) if demo_dir else REPO / "out" / "wlasl-demo"
    sd = Path(signs_dir)
    have = set()
    for d in ("/wlasl-demo", "/wlasl-demo/videos", "/lib/videos"):
        try:
            have |= {e.path.lstrip("/") for e in vol.listdir(d)}
        except Exception:  # noqa: BLE001 - not there yet
            pass
    lib = json.loads((sd / "index.json").read_text(encoding="utf-8"))
    sub = {g: lib[g] for g in DEMO_GLOSSES if g in lib}
    n = 0
    with vol.batch_upload(force=True) as b:
        b.put_file(str(dd / "index.json"), "/wlasl-demo/index.json")
        for f in sorted(dd.glob("cache-*.npz")):
            b.put_file(str(f), f"/wlasl-demo/{f.name}")
            n += 1
        for f in sorted((dd / "videos").glob("*")):
            if f"wlasl-demo/videos/{f.name}" not in have:
                b.put_file(str(f), f"/wlasl-demo/videos/{f.name}")
                n += 1
        (dd / "lib-index.json").write_text(json.dumps(sub))
        b.put_file(str(dd / "lib-index.json"), "/lib/index.json")
        for e in sub.values():
            f = sd / e["file"]
            if f.exists() and f"lib/{e['file']}" not in have:
                b.put_file(str(f), f"/lib/{e['file']}")
                n += 1
    print(f"uploaded {n} files to volume {VOLUME} (caches, {len(list((dd / 'videos').glob('*')))} clips, {len(sub)} library clips)")


# ── Generic model (no enrollment): gather more signers + negatives, then eval_generic.py ──

@app.function(volumes={"/vol": vol}, cpu=2.0, memory=3072, timeout=2 * 3600, retries=1)
def gather_chunk(lo: int, hi: int) -> str:
    """Fetch + extract jobs[lo:hi] of /vol/wlasl-gen/jobs.json (resumable: done jobs have a meta file)."""
    vol.reload()
    out = _run(["gather_wlasl.py", "--run", f"{lo},{hi}"], f"gather/{lo:05d}.log")
    return out.strip().splitlines()[-1] if out.strip() else "(no output)"


@app.function(volumes={"/vol": vol}, timeout=600)
def gather_jobs() -> int:
    import json

    vol.reload()
    Path("/vol/logs/gather").mkdir(parents=True, exist_ok=True)
    print(_run(["gather_wlasl.py", "--jobs", "--wlasl", "/vol/meta/WLASL_v0.3.json", "--dict", "/vol/meta/index.json"], "gather/jobs.log"))
    return len(json.loads(Path(f"{GEN}/jobs.json").read_text()))


@app.function(volumes={"/vol": vol}, cpu=8.0, memory=16384, timeout=3 * 3600)
def generic_eval(args: str, log: str) -> str:
    """eval_generic.py <args> (the generic-model experiments), log -> /vol/logs/<log>."""
    vol.reload()
    return _run(["eval_generic.py", *args.split()], log)


@app.local_entrypoint()
def gather(chunk: int = 20, lo: int = 0, hi: int = 0):
    """modal run --detach app/recognizer/modal_sign_eval.py::gather  (after upload_gen). --lo/--hi: a job range only."""
    n = gather_jobs.remote()
    hi = min(n, hi) if hi else n
    parts = [(k, min(hi, k + chunk)) for k in range(lo, hi, chunk)]
    print(f"{n} jobs in {len(parts)} containers")
    for r in gather_chunk.starmap(parts, return_exceptions=True):
        print(r)


@app.local_entrypoint()
def run_generic(args: str = "isolated", log: str = "generic.log"):
    """modal run --detach app/recognizer/modal_sign_eval.py::run_generic --args "isolated --variants base,mirror" --log x.log"""
    print(generic_eval.remote(args, log))


@app.local_entrypoint()
def upload_gen(wlasl: str, dict_index: str, demo_dir: str = ""):
    """WLASL_v0.3.json + the dictionary index.json -> /vol/meta; the existing demo caches -> /vol/wlasl-demo."""
    dd = Path(demo_dir) if demo_dir else REPO / "out" / "wlasl-demo"
    with vol.batch_upload(force=True) as b:
        b.put_file(wlasl, "/meta/WLASL_v0.3.json")
        b.put_file(dict_index, "/meta/index.json")
        b.put_file(str(dd / "index.json"), "/wlasl-demo/index.json")
        for f in sorted(dd.glob("cache-*.npz")):
            b.put_file(str(f), f"/wlasl-demo/{f.name}")
    print("uploaded")
