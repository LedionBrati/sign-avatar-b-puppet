"""Give every sign clip the same wall colour, so the background doesn't jump between signs.

Each fal (H3 Max) batch repaints the wall slightly differently: clips from different batches can differ a lot in
background brightness, which flashes at every sign boundary. This script, per clip:
  1. computes a soft alpha matte of the avatar in every frame with Robust Video Matting (RVM, ONNX, local,
     free, temporally stable; follows hair strands and fingers),
  2. measures the clip's wall colour from pixels that are clearly wall (alpha < 0.02),
  3. shifts each pixel by (1 - alpha) * (target - wall): pure wall gets the full shift, the avatar none, and
     soft edges (hair, motion blur) blend in proportion, so there is no halo and the wall keeps its texture,
  4. writes a new clip with the exact same frame count and encoding (-an, H.264, 24 fps) to an output dir,
     plus a copied manifest. The source clips are never modified.

Usage (Python with onnxruntime + numpy; RVM model rvm_mobilenetv3_fp32.onnx from github.com/PeterL1n/RobustVideoMatting):
  python pipeline/normalize-backgrounds.py --src out/realtime/clips --out out/realtime/clips-norm \
      --rvm path/to/rvm_mobilenetv3_fp32.onnx [--target 30,35,41]
Run it once per clip set with the same --target, then point the server's CLIPS_DIR at the -norm dirs.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "24", "-g", "12", "-movflags", "+faststart"]


def probe(path: Path):
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                          "-show_entries", "stream=width,height,nb_read_frames", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    return int(s["width"]), int(s["height"]), int(s["nb_read_frames"])


def read_frames(path: Path, w: int, h: int) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def write_frames(frames: np.ndarray, path: Path) -> None:
    n, h, w, _ = frames.shape
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
                          "-r", "24", "-i", "-", *ENCODE, str(path)], stdin=subprocess.PIPE)
    p.stdin.write(frames.tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError(f"ffmpeg failed writing {path}")


class Matter:
    """Robust Video Matting: call reset() per clip, then alpha(frame) in order (it is recurrent)."""

    def __init__(self, model: Path, downsample: float = 0.375):
        import onnxruntime as ort
        self.sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
        self.ratio = np.array([downsample], dtype=np.float32)
        self.reset()

    def reset(self):
        self.rec = [np.zeros((1, 1, 1, 1), dtype=np.float32)] * 4

    def alpha(self, rgb: np.ndarray) -> np.ndarray:
        src = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        fgr, pha, *self.rec = self.sess.run(None, {"src": src, "r1i": self.rec[0], "r2i": self.rec[1],
                                                    "r3i": self.rec[2], "r4i": self.rec[3], "downsample_ratio": self.ratio})
        return pha[0, 0]


def process(src: Path, dst: Path, matter: "Matter", target: np.ndarray) -> dict:
    w, h, n = probe(src)
    frames = read_frames(src, w, h)
    matter.reset()
    # warm the recurrent state on the first frames so frame 0 gets a settled matte too
    for f in frames[: min(6, n)]:
        matter.alpha(f)
    alphas = np.stack([matter.alpha(f) for f in frames])  # (n, h, w), 1 = avatar
    wall = alphas < 0.02
    if wall.sum() < 1000:
        raise RuntimeError(f"{src.name}: almost no wall pixels found; skipped")
    wall_mean = frames[wall].reshape(-1, 3).astype(np.float64).mean(0)
    offset = (target - wall_mean).astype(np.float32)
    out = np.clip(frames.astype(np.float32) + (1.0 - alphas)[..., None] * offset, 0, 255).round().astype(np.uint8)
    write_frames(out, dst)
    _, _, n2 = probe(dst)
    if n2 != n:
        raise RuntimeError(f"{dst.name}: frame count {n2} != {n}")
    core = alphas > 0.98
    max_core = float(np.abs(out[core].astype(int) - frames[core].astype(int)).max()) if core.any() else 0.0
    return {"frames": n, "wall_before": wall_mean.round(1).tolist(), "offset": offset.round(1).tolist(),
            "max_change_on_avatar": max_core}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="clip dir with manifest.json")
    ap.add_argument("--out", required=True, help="output dir (created; manifest copied)")
    ap.add_argument("--target", default="30,35,41", help="target wall colour R,G,B (default: the typical dark wall)")
    ap.add_argument("--rvm", required=True, help="path to rvm_mobilenetv3_fp32.onnx")
    args = ap.parse_args()

    src, out = Path(args.src), Path(args.out)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    out.mkdir(parents=True, exist_ok=True)
    target = np.array([float(x) for x in args.target.split(",")])
    matter = Matter(Path(args.rvm))

    report, done = {}, set()
    for motion_id, entry in manifest.items():
        f = entry["file"]
        if f in done:
            continue
        done.add(f)
        try:
            report[f] = process(src / f, out / f, matter, target)
            r = report[f]
            print(f"{f}: wall {r['wall_before']} -> offset {r['offset']}  avatar max change {r['max_change_on_avatar']}", flush=True)
        except Exception as e:  # keep going; the clip is copied unchanged so nothing goes missing
            shutil.copy2(src / f, out / f)
            report[f] = {"error": str(e)}
            print(f"{f}: kept original ({e})", file=sys.stderr, flush=True)
    shutil.copy2(src / "manifest.json", out / "manifest.json")
    (out / "normalize-report.json").write_text(json.dumps({"target": target.tolist(), "clips": report}, indent=1), encoding="utf-8")
    errors = [k for k, v in report.items() if "error" in v]
    print(f"done: {len(report)} clips, {len(errors)} kept unchanged{': ' + ', '.join(errors) if errors else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
