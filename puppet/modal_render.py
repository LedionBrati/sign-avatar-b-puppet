"""Render puppet videos on Modal: headless Chrome + ffmpeg in containers, so the laptop stays cool.

Needs `pip install modal` and `modal setup`. Commands run from the repo root. Free to write, not free to run:
CPU containers cost a few cents per render; see the experiment log for sizes.

1. Upload the avatar files and the motions (resumable; files already on the volume are skipped):

    modal run puppet/modal_render.py::upload --models puppet/models \
        --motions out/race/demo3/demo3.clean.json,out/motion/wlasl/hello-aaf4c6.clean.json,...

   puppet/models needs signer.glb (node puppet/avatar/build.mjs) and VRM1_Constraint_Twist_Sample.vrm
   (node puppet/fetch-model.mjs). Motions go to /motion/<file name>, so names must be unique.

2. Render (one container per motion, in parallel). Outputs land in /renders/<stem>-<avatar>[.<pass>].mp4 + .json:

    modal run puppet/modal_render.py --motions demo3.clean.json --avatar signer --passes rgb,depth,normal
    modal run puppet/modal_render.py --motions demo3.clean.json --avatar vrm          # the old anime puppet
    modal volume get signlayer-renders /renders out/modal

3. Frame grids (old vs new, same frames) and the speed benchmark:

    modal run puppet/modal_render.py::grid --videos phr-3-vrm.mp4,phr-3-signer.mp4 --frames 40,63,100,140,200 --out phr-3-grid.png
    modal run puppet/modal_render.py::bench --motion phr-3.clean.json
    modal run puppet/modal_render.py::probe_gpu        # does Chrome's WebGL use the cloud GPU? (T4, 10 frames)

GPU or CPU: headless Chrome only gets hardware WebGL on Linux through ANGLE + Vulkan, which needs the NVIDIA
Vulkan driver in the container. `probe_gpu` tries it on a T4 and reports the WebGL renderer; render.mjs refuses
to run --gpu on software, so a GPU is never paid for silently. Until the probe says "hardware", renders use
CPU containers (SwiftShader, which uses every core) and --lite shading, which was the fastest software setting.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
VOLUME = "signlayer-renders"
CPU = 16.0          # SwiftShader scales with cores; one motion per container
GPU_PROBE = "T4"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("curl", "wget", "gnupg", "ca-certificates", "ffmpeg", "fonts-liberation", "xz-utils",
                 "libvulkan1", "mesa-vulkan-drivers")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
        "wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
        " && apt-get update && apt-get install -y /tmp/chrome.deb && rm /tmp/chrome.deb",
    )
    # dependencies first (cached layer), installed outside the source tree and linked in at run time
    .add_local_file(str(HERE / "package.json"), "/opt/puppet-deps/package.json", copy=True)
    .add_local_file(str(HERE / "package-lock.json"), "/opt/puppet-deps/package-lock.json", copy=True)
    .run_commands("cd /opt/puppet-deps && npm ci --no-audit --no-fund")
    .env({"CHROME": "/usr/bin/google-chrome"})
    .add_local_dir(str(HERE), "/root/puppet", ignore=["node_modules", "dist", "models", "**/*.mp4", "__pycache__"])
)
vol = modal.Volume.from_name(VOLUME, create_if_missing=True)
app = modal.App("signlayer-renders", image=image)


def _workdir() -> Path:
    """A writable copy of puppet/ with node_modules and the avatar models linked in. render.mjs resolves the repo
    root as puppet/.., which is fine: every path we pass is absolute."""
    w = Path("/tmp/repo/puppet")
    if not w.exists():
        shutil.copytree("/root/puppet", w)
        (w / "node_modules").symlink_to("/opt/puppet-deps/node_modules")
        (w / "models").symlink_to("/vol/models")
    return w


def _node(args: list[str], cwd: Path) -> str:
    p = subprocess.run(["node", *args], cwd=cwd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"node {' '.join(args[:1])} failed ({p.returncode}):\n{p.stdout[-3000:]}\n{p.stderr[-3000:]}")
    return p.stdout


@app.function(volumes={"/vol": vol}, cpu=CPU, memory=8192, timeout=3600)
def render_one(motion: str, avatar: str = "signer", passes: str = "rgb,depth,normal", lite: bool = True,
               extra: list[str] | None = None, gpu: bool = False, model: str = "", bg_image: str = "",
               frames: int = 0) -> dict:
    """Render /vol/motion/<motion> to /vol/renders/<stem>-<avatar>.mp4 (+ .depth/.normal/.seg mp4 and the .json report).
    model: another avatar on the volume (/models/<model>, e.g. signer-bob.glb); the output is then <stem>-<model stem>.mp4.
    bg_image: an image on the volume (/models/<bg_image>, e.g. wall-plate.jpg) behind the avatar."""
    w = _workdir()
    stem = motion.removesuffix(".json").removesuffix(".clean")  # x.v2.json -> x.v2, so v1 and v2 renders differ
    tag = Path(model).stem if model else avatar
    out = Path(f"/vol/renders/{stem}-{tag}.mp4")
    out.parent.mkdir(parents=True, exist_ok=True)
    args = [str(w / "render.mjs"), "--motion", f"/vol/motion/{motion}", "--view", "vrm", "--out", str(out)]
    if avatar == "signer":
        args += ["--avatar", "signer", "--passes", passes, "--aa", "0"] + (["--lite"] if lite and not gpu else [])
    if model:
        args += ["--model", f"/models/{model}"]
    if bg_image:
        args += ["--bg-image", f"/vol/models/{bg_image}"]
    if frames:
        args += ["--frames", str(frames)]
    if gpu:
        args.append("--gpu")
    args += extra or []
    t0 = time.time()
    log = _node(args, w)
    vol.commit()
    rep = json.loads(Path(str(out).removesuffix(".mp4") + ".json").read_text())
    return {"motion": motion, "out": str(out), "wall_s": round(time.time() - t0, 1), "s_per_frame": rep.get("seconds_per_frame"),
            "webgl": rep.get("webgl"), "frames": rep.get("frames"), "hand_limits": rep.get("hand_limits"), "log_tail": log[-600:]}


@app.function(volumes={"/vol": vol}, cpu=4.0, timeout=600)
def grid_remote(videos: list[str], frames: str, out: str, width: int = 360) -> str:
    w = _workdir()
    dst = Path(f"/vol/grids/{out}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    _node([str(w / "scripts/frame-grid.mjs"), "--out", str(dst), "--frames", frames, "--width", str(width),
           *[v if v.startswith("/") else f"/vol/renders/{v}" for v in videos]], w)
    vol.commit()
    return str(dst)


@app.function(volumes={"/vol": vol}, cpu=CPU, memory=8192, timeout=7200)
def bench_remote(motion: str, frames: str = "", only: str = "") -> str:
    w = _workdir()
    args = [str(w / "scripts/bench.mjs"), "--motion", f"/vol/motion/{motion}", "--out-dir", "/vol/bench"]
    if frames:
        args += ["--frames", frames]
    if only:
        args += ["--only", only]
    log = _node(args, w)
    vol.commit()
    return log


@app.function(volumes={"/vol": vol}, gpu=GPU_PROBE, cpu=4.0, timeout=900)
def probe_gpu_remote(motion: str) -> str:
    """10 frames with --gpu: render.mjs stops with an error if Chrome's WebGL is still software."""
    w = _workdir()
    nv = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True).stdout.strip()
    out = "/vol/probe/probe.mp4"
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    try:
        log = _node([str(w / "render.mjs"), "--motion", f"/vol/motion/{motion}", "--view", "vrm", "--avatar", "signer",
                     "--frames", "10", "--gpu", "--out", out], w)
        return f"{nv}\nHARDWARE WebGL works:\n{log[-800:]}"
    except RuntimeError as e:
        return f"{nv}\nno hardware WebGL (use the CPU containers):\n{str(e)[-1500:]}"


@app.local_entrypoint()
def main(motions: str, avatar: str = "signer", passes: str = "rgb,depth,normal", lite: bool = True, gpu: bool = False,
         model: str = "", bg_image: str = "", frames: int = 0):
    """--motions a.clean.json,b.v2.json (names on the volume, under /motion). --avatar signer|vrm.
    --model signer-bob.glb --bg-image wall-plate.jpg: the lookalike avatar in front of the photo wall (both under /models)."""
    names = [m for m in motions.split(",") if m]
    t0 = time.time()
    rows = list(render_one.map(names, kwargs={"avatar": avatar, "passes": passes, "lite": lite, "gpu": gpu, "model": model,
                                              "bg_image": bg_image, "frames": frames}, return_exceptions=True))
    for r in rows:
        print(json.dumps(r if isinstance(r, dict) else {"error": str(r)[-1500:]}))
    print(json.dumps({"renders": len(rows), "errors": sum(1 for r in rows if not isinstance(r, dict)), "wall_s": round(time.time() - t0, 1)}))


@app.local_entrypoint()
def upload(motions: str = "", models: str = ""):
    """--motions comma-separated local motion files -> /motion/<name>; --models a folder -> /models/ (.glb, .vrm, and
    .jpg/.png background plates)."""
    def have(path: str) -> set[str]:
        try:
            return {e.path.split("/")[-1] for e in vol.listdir(path)}
        except Exception:
            return set()
    n = 0
    with vol.batch_upload(force=True) as b:
        if models:
            on = have("/models")
            for f in Path(models).iterdir():
                if f.suffix in (".glb", ".vrm", ".jpg", ".png") and f.name not in on:
                    b.put_file(str(f), f"/models/{f.name}"); n += 1
        on = have("/motion")
        for m in [Path(x) for x in motions.split(",") if x]:
            if m.name not in on:
                b.put_file(str(m), f"/motion/{m.name}"); n += 1
    print(f"uploaded {n} file(s) to volume {VOLUME}")


@app.local_entrypoint()
def grid(videos: str, frames: str, out: str, width: int = 360):
    """--videos x.mp4,y.mp4 (under /renders, or absolute volume paths) --frames 40,63 --out name.png -> /grids/."""
    print(grid_remote.remote(videos.split(","), frames, out, width))


@app.local_entrypoint()
def bench(motion: str, frames: str = "", only: str = ""):
    print(bench_remote.remote(motion, frames, only))


@app.local_entrypoint()
def probe_gpu(motion: str = "demo3.clean.json"):
    print(probe_gpu_remote.remote(motion))
