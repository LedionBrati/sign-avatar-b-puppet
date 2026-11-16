"""Production renders for pipeline/produce.mjs on Modal: the puppet code it runs is the renderer commit you chose.

produce.mjs exports `git archive <renderer sha> puppet` to out/produce/renderers/<sha>/puppet (with a RENDERER_SHA
file) and runs this with PRODUCE_PUPPET_DIR pointing at it, so the container renders with exactly that commit
(not this checkout's puppet/). Each render also returns the sha it ran, and produce.mjs refuses a mismatch.

    PRODUCE_PUPPET_DIR=.../renderers/<sha>/puppet modal run pipeline/produce/modal_render_prod.py --spec SPEC.json

SPEC.json (written by produce.mjs):
    {"result": "<local result.json>", "avatar_model": "signer", "placement": "ik", "render_fps": 24, "sha": "<sha>",
     "models": [["<local .glb>", "/models/signer-bob.glb"]],            # optional uploads (overwrite)
     "jobs": [{"name": "demo-1a2b3c4d", "motion_local": "...", "motion_vol": "/produce/demo/motion/x.clean.json",
               "out_vol": "/produce/demo/renders/x-<key>.mp4", "out_local": "...mp4", "report_local": "...json"}]}

Same container recipe as puppet/modal_render.py (headless Chrome + SwiftShader on 16 CPUs, --lite, --aa 0, rgb only).
The motion is composed at 48 fps for half speed and rendered with --fps 24, so the video plays at half speed.
Volume: signlayer-renders (motions, renders, /models/signer.glb). Free to write, a few cents per render to run.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import modal

VOLUME = "signlayer-renders"
CPU = 16.0
PUPPET = Path(os.environ.get("PRODUCE_PUPPET_DIR", "/root/puppet"))   # local path at `modal run`; unused in the container

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("curl", "wget", "gnupg", "ca-certificates", "ffmpeg", "fonts-liberation", "xz-utils",
                 "libvulkan1", "mesa-vulkan-drivers")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
        "wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
        " && apt-get update && apt-get install -y /tmp/chrome.deb && rm /tmp/chrome.deb",
    )
    .add_local_file(str(PUPPET / "package.json"), "/opt/puppet-deps/package.json", copy=True)
    .add_local_file(str(PUPPET / "package-lock.json"), "/opt/puppet-deps/package-lock.json", copy=True)
    .run_commands("cd /opt/puppet-deps && npm ci --no-audit --no-fund")
    .env({"CHROME": "/usr/bin/google-chrome"})
    .add_local_dir(str(PUPPET), "/root/puppet", ignore=["node_modules", "dist", "models", "**/*.mp4", "__pycache__"])
)
vol = modal.Volume.from_name(VOLUME, create_if_missing=True)
app = modal.App("signlayer-produce-render", image=image)


def _workdir() -> Path:
    w = Path("/tmp/repo/puppet")
    if not w.exists():
        shutil.copytree("/root/puppet", w)
        (w / "node_modules").symlink_to("/opt/puppet-deps/node_modules")
        (w / "models").symlink_to("/vol/models")
    return w


def _frames(mp4: str) -> int:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                          "stream=nb_read_packets", "-of", "csv=p=0", mp4], capture_output=True, text=True).stdout.strip()
    return int(out) if out.isdigit() else -1


@app.function(volumes={"/vol": vol}, cpu=CPU, memory=8192, timeout=3600)
def render_job(job: dict, avatar_model: str = "signer", placement: str = "ik", render_fps: int = 24) -> dict:
    w = _workdir()
    sha_file = Path("/root/puppet/RENDERER_SHA")
    sha = sha_file.read_text().strip() if sha_file.exists() else None
    out = Path("/vol" + job["out_vol"])
    out.parent.mkdir(parents=True, exist_ok=True)
    args = [str(w / "render.mjs"), "--motion", "/vol" + job["motion_vol"], "--view", "vrm", "--out", str(out),
            "--avatar", "signer", "--passes", "rgb", "--aa", "0", "--lite", "--fps", str(render_fps)]
    if avatar_model != "signer":
        args += ["--model", f"/models/{avatar_model}.glb"]
    if placement != "auto":
        args += ["--placement", placement]
    t0 = time.time()
    p = subprocess.run(["node", *args], cwd=w, capture_output=True, text=True)
    vol.commit()
    report_path = Path(str(out).removesuffix(".mp4") + ".json")
    if p.returncode != 0:
        return {"name": job["name"], "ok": False, "sha": sha, "error": f"render.mjs exit {p.returncode}",
                "log_tail": (p.stdout[-2000:] + "\n" + p.stderr[-2000:])}
    rep = json.loads(report_path.read_text()) if report_path.exists() else {}
    return {"name": job["name"], "ok": True, "sha": sha, "wall_s": round(time.time() - t0, 1), "frames_video": _frames(str(out)),
            "frames_report": rep.get("frames"), "fps": rep.get("fps"), "s_per_frame": rep.get("seconds_per_frame"),
            "webgl": rep.get("webgl"), "placement": (rep.get("avatar") or {}).get("placement"),
            "model": rep.get("model"), "report_vol": str(report_path).removeprefix("/vol"), "log_tail": p.stdout[-800:]}


@app.local_entrypoint()
def main(spec: str):
    s = json.loads(Path(spec).read_text(encoding="utf-8"))
    jobs = s["jobs"]
    t0 = time.time()
    with vol.batch_upload(force=True) as b:
        for local, remote in s.get("models", []):
            b.put_file(local, remote)
        for j in jobs:
            b.put_file(j["motion_local"], j["motion_vol"])
    print(f"uploaded {len(jobs)} motion(s); rendering on Modal ({CPU:.0f} CPU each)", flush=True)
    rows = list(render_job.map(jobs, kwargs={"avatar_model": s.get("avatar_model", "signer"), "placement": s.get("placement", "ik"),
                                             "render_fps": int(s.get("render_fps", 24))}, return_exceptions=True))
    results = []
    for j, r in zip(jobs, rows):
        if not isinstance(r, dict):
            results.append({"name": j["name"], "ok": False, "error": str(r)[-1500:]})
            continue
        if r.get("ok"):
            for remote, local in ((j["out_vol"], j["out_local"]), (r["report_vol"], j["report_local"])):
                Path(local).parent.mkdir(parents=True, exist_ok=True)
                with open(local, "wb") as f:
                    for chunk in vol.read_file(remote):
                        f.write(chunk)
        results.append(r)
        print(json.dumps({k: r.get(k) for k in ("name", "ok", "sha", "frames_video", "wall_s", "placement", "error")}), flush=True)
    Path(s["result"]).write_text(json.dumps({"results": results, "wall_s": round(time.time() - t0, 1)}, indent=1), encoding="utf-8")
