"""After the paid repaint, for pipeline/produce.mjs on Modal: finger scores per take, then cut + even the clip folder.

    modal run pipeline/produce/modal_post.py::score  --spec SPEC.json   # MediaPipe on every take (score_takes.py)
    modal run pipeline/produce/modal_post.py::finish --spec SPEC.json   # cut, even (even-clips.mjs), aliases, sentences

score SPEC:  {"result": "<local json>", "jobs": [{"name", "ref_vol", "motion_vol", "segments": [...], "expect_frames": N,
              "score": true, "takes": [[k, "/produce/<variant>/takes/x-t0.mp4", "<fal result url or null>"]]}]}
             Takes are fetched from fal straight onto the volume (never through the laptop), frame-counted, then scored.
finish SPEC: {"result": "<local json>", "stage": "<local dir>", "finish": {... finish.mjs spec with /vol paths ...}}
The final folder lives on the volume (/produce/<variant>/final); what changed comes back as a tar, is unpacked into
`stage`, and produce.mjs copies it into out/realtime/clips-v2-<variant>/ (manifest.json last).
CPU only, no fal, no keys. Volume: signlayer-renders.
"""
from __future__ import annotations

import io
import json
import sys
import tarfile
import time
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
VOLUME = "signlayer-renders"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("curl", "ca-certificates", "gnupg", "ffmpeg", "libgl1", "libglib2.0-0")
    .run_commands("curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs")
    .pip_install("mediapipe==1.2.3", "numpy>=1.26,<3", "scipy>=1.13")
    .env({"FINGER_CACHE": "/tmp/finger-cache", "HOLISTIC_MODEL": "/vol/models/holistic_landmarker.task"})
    .add_local_file(str(REPO / "motion/finger_fidelity.py"), "/root/motion/finger_fidelity.py")
    .add_local_file(str(REPO / "motion/common.py"), "/root/motion/common.py")
    .add_local_dir(str(REPO / "pipeline/lib"), "/root/pipeline/lib")
    .add_local_file(str(REPO / "pipeline/even-clips.mjs"), "/root/pipeline/even-clips.mjs")
    .add_local_file(str(REPO / "pipeline/produce/finish.mjs"), "/root/pipeline/produce/finish.mjs")
    .add_local_file(str(REPO / "pipeline/produce/score_takes.py"), "/root/pipeline/produce/score_takes.py")
)
vol = modal.Volume.from_name(VOLUME, create_if_missing=True)
app = modal.App("signlayer-produce-post", image=image)


def _model() -> None:
    """The MediaPipe holistic model, downloaded once to the volume (free, public Google bucket)."""
    p = Path("/vol/models/holistic_landmarker.task")
    if not p.exists():
        sys.path.insert(0, "/root/motion")
        from common import ensure_model
        ensure_model(p)
        vol.commit()


def _probe(mp4: str) -> int:
    import subprocess
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                          "stream=nb_read_packets", "-of", "csv=p=0", mp4], capture_output=True, text=True).stdout.strip()
    return int(out) if out.isdigit() else -1


@app.function(volumes={"/vol": vol}, cpu=4.0, memory=8192, timeout=3600)
def score_job(job: dict) -> dict:
    """Fetch each take from its fal URL onto the volume (once), count its frames, and score the ones that match."""
    import urllib.request
    t0 = time.time()
    meta = []
    for k, path, url in job["takes"]:
        p = Path("/vol" + path)
        if not p.exists() and url:
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".part")
            with urllib.request.urlopen(url, timeout=600) as r, open(tmp, "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            tmp.replace(p)
            vol.commit()
        frames = _probe(str(p)) if p.exists() else -1
        meta.append({"k": int(k), "vol": path, "frames": frames, "ok": frames == job["expect_frames"], "bytes": p.stat().st_size if p.exists() else 0})
    out = {"name": job["name"], "takes_meta": meta, "score": None}
    good = [(m["k"], "/vol" + m["vol"]) for m in meta if m["ok"]]
    if job.get("score", True) and good:
        _model()
        sys.path.insert(0, "/root/pipeline/produce")
        from score_takes import score
        out["score"] = score("/vol" + job["ref_vol"], "/vol" + job["motion_vol"] if job.get("motion_vol") else None, job["segments"], good)
    out["wall_s"] = round(time.time() - t0, 1)
    return out


@app.function(volumes={"/vol": vol}, cpu=8.0, memory=8192, timeout=7200)
def finish_job(spec: dict) -> bytes:
    """finish.mjs on the persistent /vol final folder; returns a tar of what changed (+ manifest and reports)."""
    import subprocess
    spec = {**spec, "raw": "/tmp/raw", "inc": "/tmp/inc"}
    Path("/tmp/finish.json").write_text(json.dumps(spec))
    vol.reload()
    p = subprocess.run(["node", "/root/pipeline/produce/finish.mjs", "--spec", "/tmp/finish.json"], capture_output=True, text=True)
    vol.commit()
    if p.returncode != 0:
        raise RuntimeError(f"finish.mjs exit {p.returncode}: {p.stdout[-3000:]} {p.stderr[-3000:]}")
    line = [x for x in p.stdout.splitlines() if x.startswith("FINISH_RESULT ")][-1]
    res = json.loads(line.removeprefix("FINISH_RESULT "))
    final = Path(spec["final"])
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for rel in sorted(set(res["changed"])):
            if (final / rel).exists():
                tar.add(str(final / rel), arcname=rel)
        for name, text in (("finish-log.txt", p.stdout + p.stderr), ("finish-result.json", json.dumps(res))):
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def _upload(pairs: list) -> int:
    if not pairs:
        return 0
    with vol.batch_upload(force=True) as b:
        for local, remote in pairs:
            b.put_file(local, remote)
    return len(pairs)


@app.local_entrypoint()
def score(spec: str):
    s = json.loads(Path(spec).read_text(encoding="utf-8"))
    print(f"uploaded {_upload(s.get('uploads', []))} file(s); fetching + checking + scoring {len(s['jobs'])} batch(es)", flush=True)
    rows = list(score_job.map(s["jobs"], return_exceptions=True))
    out = [r if isinstance(r, dict) else {"name": j["name"], "error": str(r)[-1500:]} for j, r in zip(s["jobs"], rows)]
    Path(s["result"]).write_text(json.dumps({"results": out}, indent=1), encoding="utf-8")
    print(json.dumps({"batches": len(out), "errors": sum(1 for r in out if "error" in r)}))


@app.local_entrypoint()
def finish(spec: str):
    s = json.loads(Path(spec).read_text(encoding="utf-8"))
    print(f"uploaded {_upload(s.get('uploads', []))} file(s); finishing {len(s['finish']['clips'])} clip(s) on Modal", flush=True)
    data = finish_job.remote(s["finish"])
    stage = Path(s["stage"])
    stage.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r") as tar:
        tar.extractall(stage, filter="data")
    Path(s["result"]).write_text(json.dumps({"ok": True, "stage": str(stage), "bytes": len(data)}), encoding="utf-8")
    print(f"unpacked {len(data) / 1e6:.1f} MB into {stage}")
