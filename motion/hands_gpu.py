"""GPU hand model: WiLoR (MANO hands from single images) on every hand crop of a sign video.

    python hands_gpu.py --raw X.raw.json --video X.mp4 --out X.wilor.json \
        --wilor-dir /opt/WiLoR --ckpt /weights/wilor_final.ckpt --mano-dir /weights/mano

Then `hands3d.py ... --keypoints X.wilor.json` fits the anatomical skeleton to WiLoR's joints
instead of MediaPipe's (same limits, gap filling and smoothing).

- Crops come from the motion file (tight_box: the Holistic hand's extent, or the pose model's
  hand points when Holistic lost the hand), so WiLoR's own YOLO detector (ultralytics,
  AGPL-3.0) is not needed. Left hands are flipped and run as right hands, as WiLoR does.
- Output per frame and hand: 21 joints (MediaPipe order, camera axes x right / y down / z away,
  wrist-relative, metres), the joints projected into the image (0..1, like FORMAT v1 hands), the
  MANO parameters (axis-angle, the hand's own MANO side), and a confidence from the agreement
  with Holistic's 2D hand where Holistic has one.
- Needs the MANO model: MANO_RIGHT.pkl from https://mano.is.tue.mpg.de (free registration,
  non-commercial licence) in --mano-dir. WiLoR's refinement stage samples image features at the
  MANO mesh vertices, so it cannot run without it. `--mano stub` runs everything with a dummy
  MANO to test the plumbing on a CPU; its joints are meaningless and are marked so.

The WiLoR code (github.com/rolpotamias/WiLoR, CC BY-NC-ND 4.0) is imported from --wilor-dir
without its package __init__ files, so the renderer (pyrender/OpenGL) and the YOLO detector are
never loaded.
"""
from __future__ import annotations

import argparse
import importlib
import json
import math
import sys
import time
import types
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

RESCALE = 2.0  # WiLoR pads its (YOLO) hand box by this factor; we hand it a tight box too


def tight_box(frame: dict, side: str, W: int, H: int):
    """Tight square hand box (cx, cy, side_px) for WiLoR: the Holistic hand's extent, or ~2.4
    wrist->knuckle lengths around the pose model's hand when Holistic lost it. None when the
    hand is not in the picture (pose wrist not visible or at the bottom edge)."""
    hand = frame.get(f"{side}Hand")
    if hand is not None:
        p = np.array(hand)[:, :2] * [W, H]
        lo, hi = p.min(0), p.max(0)
        c = (lo + hi) / 2
        return float(c[0]), float(c[1]), float(max(max(hi - lo), 24.0))
    pose = frame.get("pose")
    if pose is None:
        return None
    from redetect import POSE_HAND

    P = np.array(pose, dtype=float)
    w, pk, ix = (P[k] for k in POSE_HAND[side][:3])
    if w[3] < 0.5 or w[1] > 0.97:
        return None
    wp, kn = w[:2] * [W, H], (pk[:2] + ix[:2]) / 2 * [W, H]
    c = wp + 1.1 * (kn - wp)
    if not (0 <= c[0] < W and 0 <= c[1] < H):
        return None
    return float(c[0]), float(c[1]), float(max(2.4 * np.hypot(*(kn - wp)), 24.0))


def _stub_package(name: str, path: Path, **attrs):
    m = types.ModuleType(name)
    m.__path__ = [str(path)]
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


class StubMANO:
    """Stand-in for MANO when MANO_RIGHT.pkl is absent (plumbing test only)."""

    def __init__(self, torch):
        self.torch = torch
        self.faces = np.zeros((1538, 3), dtype=np.int64)

    def __call__(self, global_orient=None, hand_pose=None, betas=None, pose2rot=False, **kw):
        B = global_orient.shape[0]
        z = self.torch.zeros
        return types.SimpleNamespace(vertices=z(B, 778, 3, device=global_orient.device, dtype=global_orient.dtype),
                                     joints=z(B, 21, 3, device=global_orient.device, dtype=global_orient.dtype))


def load_wilor(wilor_dir: str, ckpt: str, cfg_path: str | None, mano_dir: str | None, mano: str, device: str):
    import torch

    wd = Path(wilor_dir)
    _stub_package("wilor", wd / "wilor")
    _stub_package("wilor.utils", wd / "wilor" / "utils", SkeletonRenderer=None, MeshRenderer=None)
    models = _stub_package("wilor.models", wd / "wilor" / "models")
    _stub_package("wilor.datasets", wd / "wilor" / "datasets")
    from wilor.configs import get_config  # noqa: E402

    cfg = get_config(str(cfg_path or wd / "pretrained_models" / "model_config.yaml"), update_cachedir=True)
    cfg.defrost()
    cfg.MODEL.BBOX_SHAPE = [192, 256]
    cfg.MODEL.BACKBONE.pop("PRETRAINED_WEIGHTS", None)
    mdir = Path(mano_dir) if mano_dir else wd / "mano_data"
    cfg.MANO.DATA_DIR = str(mdir)
    cfg.MANO.MODEL_PATH = str(mdir)
    mean = mdir / "mano_mean_params.npz"
    cfg.MANO.MEAN_PARAMS = str(mean if mean.exists() else wd / "mano_data" / "mano_mean_params.npz")
    cfg.freeze()
    if mano == "stub":
        models.MANO = lambda **kw: StubMANO(torch)
    else:
        if not (mdir / "MANO_RIGHT.pkl").exists():
            raise SystemExit(f"MANO_RIGHT.pkl not found in {mdir}. Register at https://mano.is.tue.mpg.de, "
                             "download 'Models & Code', copy mano_v1_2/models/MANO_RIGHT.pkl there "
                             "(or run with --mano stub to test the plumbing).")
        models.MANO = importlib.import_module("wilor.models.mano_wrapper").MANO
    WiLoR = importlib.import_module("wilor.models.wilor").WiLoR
    model = WiLoR(cfg, init_renderer=False)
    sd = torch.load(ckpt, map_location="cpu", weights_only=False)
    sd = sd.get("state_dict", sd)
    missing, unexpected = model.load_state_dict(sd, strict=False)
    real_missing = [k for k in missing if not k.startswith("mano.")]
    if real_missing:
        raise SystemExit(f"checkpoint does not match the WiLoR code: {len(real_missing)} missing keys, e.g. {real_missing[:5]}")
    model.to(device).eval()
    vitdet = importlib.import_module("wilor.datasets.vitdet_dataset")
    return model, cfg, vitdet, {"missing": len(missing), "unexpected": len(unexpected)}


def cam_crop_to_full(cam_bbox, box_center, box_size, img_size, focal_length):
    """WiLoR's weak-perspective crop camera -> full-image translation (copied from wilor.utils.renderer)."""
    import torch

    img_w, img_h = img_size[:, 0], img_size[:, 1]
    cx, cy, b = box_center[:, 0], box_center[:, 1], box_size
    bs = b * cam_bbox[:, 0] + 1e-9
    tz = 2 * focal_length / bs
    tx = (2 * (cx - img_w / 2.0) / bs) + cam_bbox[:, 1]
    ty = (2 * (cy - img_h / 2.0) / bs) + cam_bbox[:, 2]
    return torch.stack([tx, ty, tz], dim=-1)


def _rotmat_to_aa(R):
    from scipy.spatial.transform import Rotation

    return Rotation.from_matrix(R.reshape(-1, 3, 3)).as_rotvec().reshape(-1).tolist()


def run_video(model, cfg, vitdet, raw: dict, video: str, device: str, batch: int = 32, fp16: bool = False) -> dict:
    import torch
    from common import round_points
    from redetect import read_frames

    W, H = raw["width"], raw["height"]
    jobs = [(f["i"], s, b) for f in raw["frames"] for s in ("left", "right")
            if (b := tight_box(f, s, W, H)) is not None]
    rgbs = read_frames(video, {i for i, _, _ in jobs}, mirror=bool(raw.get("mirrored")))
    frames_by_i = {f["i"]: f for f in raw["frames"]}
    out: dict = {}
    focal = cfg.EXTRA.FOCAL_LENGTH / cfg.MODEL.IMAGE_SIZE * max(W, H)
    items = []
    for i, side, (cx, cy, t) in jobs:
        if i not in rgbs:
            continue
        bgr = np.ascontiguousarray(rgbs[i][:, :, ::-1])
        ds = vitdet.ViTDetDataset(cfg, bgr, np.array([[cx - t / 2, cy - t / 2, cx + t / 2, cy + t / 2]]),
                                  np.array([1.0 if side == "right" else 0.0]), rescale_factor=RESCALE, fp16=fp16)
        items.append((i, side, ds[0]))
    for k in range(0, len(items), batch):
        chunk = items[k:k + batch]
        coll = torch.utils.data.default_collate([it[2] for it in chunk])
        coll = {kk: (v.to(device) if hasattr(v, "to") else v) for kk, v in coll.items()}
        with torch.no_grad():
            o = model(coll)
        right = coll["right"].float()
        cam = o["pred_cam"].clone()
        cam[:, 1] = (2 * right - 1) * cam[:, 1]
        cam_t = cam_crop_to_full(cam, coll["box_center"].float(), coll["box_size"].float(),
                                 coll["img_size"].float(), focal)
        J = o["pred_keypoints_3d"].float().cpu().numpy()  # (B,21,3), right-hand space, openpose order
        mp = o["pred_mano_params"]
        for n, (i, side, _) in enumerate(chunk):
            j = J[n].copy()
            if side == "left":
                j[:, 0] = -j[:, 0]
            ct = cam_t[n].float().cpu().numpy()
            pc = j + ct
            u = focal * pc[:, 0] / pc[:, 2] + W / 2
            v = focal * pc[:, 1] / pc[:, 2] + H / 2
            img = np.stack([u / W, v / H, (pc[:, 2] - pc[0, 2]) * focal / pc[:, 2] / W], 1)
            conf = 0.8
            hol = frames_by_i[i].get(f"{side}Hand")
            if hol is not None:
                h = np.array(hol)[:, :2] * [W, H]
                d = np.mean(np.linalg.norm(img[:, :2] * [W, H] - h, axis=1)) / max(np.linalg.norm(h[9] - h[0]), 1.0)
                conf = float(math.exp(-d / 0.5))
            out.setdefault(str(i), {})[side] = {
                "joints": round_points((j - j[0]).tolist()),
                "image": round_points(img.tolist()),
                "mano": {"global_orient": _rotmat_to_aa(mp["global_orient"][n].float().cpu().numpy()),
                         "hand_pose": _rotmat_to_aa(mp["hand_pose"][n].float().cpu().numpy()),
                         "betas": round_points([mp["betas"][n].float().cpu().numpy().tolist()])[0],
                         "side": side},
                "conf": round(conf, 3),
            }
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--wilor-dir", required=True)
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--cfg")
    ap.add_argument("--mano-dir")
    ap.add_argument("--mano", choices=["official", "stub"], default="official")
    ap.add_argument("--device", default=None)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--fp16", action="store_true")
    ap.add_argument("--limit-frames", type=int, help="only the first N frames (smoke tests)")
    a = ap.parse_args(argv)
    import torch

    device = a.device or ("cuda" if torch.cuda.is_available() else "cpu")
    from common import load_json, save_json

    raw = load_json(a.raw)
    if a.limit_frames:
        raw = dict(raw, frames=raw["frames"][: a.limit_frames])
    t0 = time.perf_counter()
    model, cfg, vitdet, keys = load_wilor(a.wilor_dir, a.ckpt, a.cfg, a.mano_dir, a.mano, device)
    if a.fp16 and device == "cuda":
        model = model.half()
    t1 = time.perf_counter()
    frames = run_video(model, cfg, vitdet, raw, a.video, device, a.batch, a.fp16 and device == "cuda")
    t2 = time.perf_counter()
    n = sum(len(v) for v in frames.values())
    res = {"model": "WiLoR wilor_final.ckpt" + (" (STUB MANO: joints meaningless)" if a.mano == "stub" else ""),
           "mano": a.mano, "name": raw["name"], "device": device, "frames": frames,
           "timing": {"load_s": round(t1 - t0, 1), "infer_s": round(t2 - t1, 1), "hands": n,
                      "s_per_hand": round((t2 - t1) / max(n, 1), 3)}, "state_dict": keys}
    save_json(res, a.out)
    print(json.dumps({"out": a.out, **res["timing"], "device": device, "mano": a.mano}))


if __name__ == "__main__":
    sys.exit(main())
