"""Render a motion file as an OpenPose / DWPose style skeleton video (body + both hands + face dots).

    uv run python render_pose.py ../out/race/demo3/demo3.clean.json --out ../out/race/demo3/demo3-pose.mp4

This is the pose conditioning video for pose-driven models (Wan VACE pose, LTX IC control) with
`preprocess=false`: the model then sees our own hand keypoints instead of re-detecting them from
pixels, so a pointing index stays a pointing index in the input at least.

The motion's image coords come from different WLASL signers and framings, so every frame is
re-framed by its shoulders: shoulder midpoint to (0.5, 0.457) of the frame and shoulder width to
0.39 of the frame width. That is where MediaPipe finds the shoulders of our realistic avatar in the
Recast outputs (median over 6 runs), so the skeleton has real human proportions in the same framing.
The shoulder fit is smoothed so the body does not jitter. Colours follow controlnet_aux's OpenPose
drawing, which is what these models were trained on.
"""
from __future__ import annotations

import argparse
import colorsys
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

# OpenPose body-18 from MediaPipe pose-33 (None = neck, the shoulder midpoint).
BODY18 = [0, None, 12, 14, 16, 11, 13, 15, 24, 26, 28, 23, 25, 27, 5, 2, 8, 7]
LIMBS = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13),
         (1, 0), (0, 14), (14, 16), (0, 15), (15, 17)]
COLOURS = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0),
           (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255),
           (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85)]
HAND_EDGES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (0, 9), (9, 10), (10, 11), (11, 12),
              (0, 13), (13, 14), (14, 15), (15, 16), (0, 17), (17, 18), (18, 19), (19, 20)]
TARGET_CENTRE = (0.5, 0.457)
TARGET_WIDTH = 0.39


def body18(pose: list) -> list:
    pts = []
    for k in BODY18:
        if k is None:
            a, b = pose[11], pose[12]
            pts.append(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, min(a[3], b[3]) if len(a) > 3 else 1.0))
        else:
            p = pose[k]
            pts.append((p[0], p[1], p[3] if len(p) > 3 else 1.0))
    return pts


def render(motion_path: str, out: str, width: int = 540, height: int = 720, face: bool = True, alpha: float = 0.25) -> dict:
    import cv2

    m = json.loads(Path(motion_path).read_text(encoding="utf-8"))
    sw, sh = float(m.get("width") or 1), float(m.get("height") or 1)
    fps = m.get("fps") or 24
    frames = m["frames"]
    tmp = Path(out).with_suffix(".raw.avi")
    writer = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"MJPG"), fps, (width, height))
    centre = scale = None
    hands_drawn = 0
    for f in frames:
        img = np.zeros((height, width, 3), np.uint8)
        pose = f.get("pose")
        if pose:
            a, b = np.array(pose[11][:2]) * (sw, sh), np.array(pose[12][:2]) * (sw, sh)
            c, w = (a + b) / 2, max(np.linalg.norm(a - b), 1e-6)
            centre = c if centre is None else (1 - alpha) * centre + alpha * c
            scale = w if scale is None else (1 - alpha) * scale + alpha * w
        if centre is None:
            writer.write(img)
            continue
        k = TARGET_WIDTH * width / scale

        def px(p):
            x = (p[0] * sw - centre[0]) * k + TARGET_CENTRE[0] * width
            y = (p[1] * sh - centre[1]) * k + TARGET_CENTRE[1] * height
            return int(round(x)), int(round(y))

        stick = max(2, int(round(width / 135)))
        if pose:
            pts = body18(pose)
            for n, (i, j) in enumerate(LIMBS):
                if pts[i][2] < 0.3 or pts[j][2] < 0.3:
                    continue
                p, q = px(pts[i]), px(pts[j])
                ov = img.copy()
                length = float(np.hypot(p[0] - q[0], p[1] - q[1]))
                angle = float(np.degrees(np.arctan2(q[1] - p[1], q[0] - p[0])))
                poly = cv2.ellipse2Poly(((p[0] + q[0]) // 2, (p[1] + q[1]) // 2), (int(length / 2), stick), int(angle), 0, 360, 1)
                cv2.fillConvexPoly(ov, poly, COLOURS[n][::-1])
                img = cv2.addWeighted(img, 0.4, ov, 0.6, 0)
            for n, p in enumerate(pts):
                if p[2] >= 0.3:
                    cv2.circle(img, px(p), stick + 1, COLOURS[n][::-1], -1)
        for key in ("leftHand", "rightHand"):
            hand = f.get(key)
            if not hand:
                continue
            hands_drawn += 1
            hp = [px(p) for p in hand]
            for e, (i, j) in enumerate(HAND_EDGES):
                r, g, b = colorsys.hsv_to_rgb(e / len(HAND_EDGES), 1.0, 1.0)
                cv2.line(img, hp[i], hp[j], (int(b * 255), int(g * 255), int(r * 255)), 2, cv2.LINE_AA)
            for p in hp:
                cv2.circle(img, p, 3, (0, 0, 255), -1)
        if face and f.get("face"):
            for p in f["face"][:468:4]:
                cv2.circle(img, px(p), 1, (255, 255, 255), -1)
        writer.write(img)
    writer.release()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(tmp), "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p",
                    "-r", str(fps), "-movflags", "+faststart", out], check=True)
    tmp.unlink(missing_ok=True)
    return {"out": out, "frames": len(frames), "fps": fps, "width": width, "height": height, "hand_frames": hands_drawn}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("motion")
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=540)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--no-face", action="store_true")
    a = ap.parse_args(argv)
    print(json.dumps(render(a.motion, a.out, a.width, a.height, not a.no_face)))


if __name__ == "__main__":
    sys.exit(main())
