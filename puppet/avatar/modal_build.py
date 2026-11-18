"""Build the signer avatar (build_avatar.py) in headless Blender on Modal, so the laptop stays cool.

Needs `pip install modal` and `modal setup`. Commands run from the repo root. Blender 4.5, MPFB 2.0.18 and the
MakeHuman CC0 asset pack are baked into the image (same files as puppet/avatar/build.mjs downloads).

    modal run puppet/avatar/modal_build.py --name signer-bob --flags "--look bob"     # -> /models/signer-bob.glb
    modal run puppet/avatar/modal_build.py --name signer                               # the default long-hair signer
    modal run puppet/avatar/modal_build.py::probe                                       # list hair / skins / face targets
    modal volume get signlayer-renders /models/signer-bob.glb puppet/models/
    modal volume get signlayer-renders /previews out/avatar-previews

The .glb lands on the signlayer-renders volume under /models/, where puppet/modal_render.py renders from.
A face close-up preview (Cycles, CPU) goes to /previews/<name>.png.
"""
from __future__ import annotations

import shlex
import subprocess
import time
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
VOLUME = "signlayer-renders"
BLENDER = "https://download.blender.org/release/Blender4.5/blender-4.5.0-linux-x64.tar.xz"
MPFB = "https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip"
ASSETS = "http://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("wget", "xz-utils", "unzip", "libxi6", "libxxf86vm1", "libxfixes3", "libxrender1", "libgl1",
                 "libxkbcommon0", "libsm6", "libice6", "libegl1", "libglu1-mesa", "libx11-6", "libxext6")
    .run_commands(
        f"wget -q -O /tmp/b.tar.xz {BLENDER} && mkdir -p /opt/blender && tar -xf /tmp/b.tar.xz -C /opt/blender --strip-components=1 && rm /tmp/b.tar.xz",
        f"wget -q -O /opt/mpfb.zip '{MPFB}'",
        f"wget -q -O /tmp/mh.zip {ASSETS} && mkdir -p /opt/mh && unzip -q /tmp/mh.zip -d /opt/mh && rm /tmp/mh.zip",
        "BLENDER_USER_RESOURCES=/opt/blender_user /opt/blender/blender --background --factory-startup "
        "--command extension install-file -r user_default -e /opt/mpfb.zip",
    )
    .env({"BLENDER_USER_RESOURCES": "/opt/blender_user"})
    .add_local_dir(str(HERE), "/root/avatar", ignore=["__pycache__"])
)
vol = modal.Volume.from_name(VOLUME, create_if_missing=True)
app = modal.App("signlayer-avatar-build", image=image)


def _blender(script: str, args: list[str]) -> str:
    p = subprocess.run(["/opt/blender/blender", "--background", "--python", script, "--", *args], capture_output=True, text=True)
    log = p.stdout + p.stderr
    if p.returncode != 0 or "Traceback" in log:
        raise RuntimeError(f"blender failed ({p.returncode}):\n{log[-5000:]}")
    return log


@app.function(volumes={"/vol": vol}, cpu=8.0, memory=8192, timeout=1800)
def build_remote(name: str, flags: str = "") -> dict:
    out = Path(f"/vol/models/{name}.glb")
    out.parent.mkdir(parents=True, exist_ok=True)
    prev = Path(f"/vol/previews/{name}.png")
    prev.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    log = _blender("/root/avatar/build_avatar.py", ["--assets", "/opt/mh", "--out", str(out), "--preview", str(prev), *shlex.split(flags)])
    vol.commit()
    keep = [l for l in log.splitlines() if l.startswith(("WROTE", "LOOK", "PART", "smoothed", "PREVIEW", "WARN"))]
    return {"out": str(out), "bytes": out.stat().st_size, "preview": str(prev), "s": round(time.time() - t0, 1), "log": keep}


PROBE = r'''
import importlib, os, inspect, glob
importlib.import_module("bl_ext.user_default.mpfb")
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.locationservice import LocationService
for n in ("load_target", "set_target_value", "target_full_path", "bake_targets"):
    f = getattr(TargetService, n, None)
    print("SIG", n, inspect.signature(f) if f else None)
t = LocationService.get_mpfb_data("targets")
print("TARGETS", t)
for g in ("head", "eyebrows", "eyes", "nose", "mouth", "chin", "cheek", "forehead", "neck", "ears"):
    fs = sorted(os.path.basename(p).replace(".target.gz", "") for p in glob.glob(os.path.join(t, g, "*.target.gz")))
    print("GROUP", g, len(fs), " ".join(fs))
for d in ("hair", "skins", "eyebrows", "eyes/materials"):
    print("ASSET", d, " ".join(sorted(os.listdir(os.path.join("/opt/mh", d)))))
'''


@app.function(cpu=2.0, timeout=600)
def probe_remote() -> str:
    Path("/tmp/probe.py").write_text(PROBE)
    log = _blender("/tmp/probe.py", [])
    return "\n".join(l for l in log.splitlines() if l.startswith(("SIG", "TARGETS", "GROUP", "ASSET")))


@app.local_entrypoint()
def main(name: str = "signer-bob", flags: str = "--look bob"):
    """--name NAME (-> /models/NAME.glb) --flags "extra build_avatar.py args"; several builds: --name a,b --flags "x|y"."""
    names, fl = name.split(","), flags.split("|")
    fl += [fl[-1]] * (len(names) - len(fl))
    for r in build_remote.starmap(list(zip(names, fl)), return_exceptions=True):
        print(r if isinstance(r, dict) else f"ERROR {str(r)[-3000:]}")


@app.local_entrypoint()
def probe():
    print(probe_remote.remote())
