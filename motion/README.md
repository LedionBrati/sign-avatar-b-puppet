# motion/

Sign videos to MediaPipe landmark JSON (the contract is [`FORMAT.md`](FORMAT.md)), plus cleanup and a finger-tracking QA report. Python, `uv`, CPU only, free.

## Quickstart

```bash
cd motion && uv sync && uv run python fetch_model.py        # deps + 14 MB holistic model into motion/models/
uv run python extract.py ../references/how2sign/judy.mp4 --out ../out/motion/judy.raw.json --dataset How2Sign --license "CC BY-NC 4.0" --signer 3
uv run python clean.py ../out/motion/judy.raw.json --out ../out/motion/judy.clean.json          # add --trim-rest for dictionary signs
uv run python report.py ../out/motion/judy.raw.json ../out/motion/judy.clean.json --video ../references/how2sign/judy.mp4 --out-dir ../out/motion/judy-report
uv run pytest -q                                              # or: bash run_how2sign.sh (all 4 clips), batch_library.py (WLASL)
```

## Files

| File | What it does |
|---|---|
| `extract.py` | HolisticLandmarker (VIDEO mode, every frame) to `.raw.json`. `--mirror` flips frames before tracking. |
| `clean.py` | `.raw.json` to `.clean.json`: optional rest trim, gap fill (<= 4 frames), One Euro smoothing, dominant hand. |
| `report.py` | Detection %, hands lost while signing, implausible jumps, raw vs clean jitter, overlay + skeleton videos, worst-frame hand crops. |
| `batch_library.py` | Resumable batch over the WLASL library (mirrors left-dominant signs, trims to rest), writes `summary.csv`. |
| `run_how2sign.sh` | extract, clean, report for the 4 How2Sign clips into `out/motion/`. |
| `common.py` | Model download, rounding, JSON IO, `mirror_frame` (mirror data without re-tracking). |
| `hand_model.py` | Articulated hand skeleton (MANO joint order, fixed bone lengths, joint limits) and its IK fit to 21 tracked points. |
| `hands3d.py` | `.raw.json` + `.clean.json` to `.v2.json`: anatomical 3D hands per frame (FORMAT.md v2), gaps filled in joint-angle space, smoothed angles. |
| `redetect.py` | Second look at missed or impossible hands: crop around the pose model's hand, zoom, MediaPipe HandLandmarker. |
| `hands_report.py` | MediaPipe vs fitted hands: detection, impossible poses, jitter, and a PNG grid of overlays. |
| `batch_hands3d.py` | Resumable batch of `hands3d.py` over the library (`--only demo` for the demo vocabulary). |
| `hands_gpu.py`, `modal_hands.py` | GPU path: WiLoR 3D hands per crop (needs MANO_RIGHT.pkl), on any CUDA box or on Modal. |
| `tests/` | pytest on synthetic data for the pure functions. |

## Anatomical hands (v2)

```bash
uv run python hands3d.py ../out/motion/wlasl/hello-aaf4c6.raw.json --clean ../out/motion/wlasl/hello-aaf4c6.clean.json \
    --video <signs>/videos/hello-aaf4c6.mp4 --out ../out/hands3d/hello-aaf4c6.v2.json
uv run python hands_report.py --raw ... --clean ... --v2 ../out/hands3d/hello-aaf4c6.v2.json --video ... --out-dir ../out/hands3d/hello-report
uv run python batch_hands3d.py --index <signs>/index.json --motion-dir ../out/motion/wlasl --out-dir ../out/hands3d --only demo --workers 4
```

GPU (better fingers from WiLoR): see the docstring of `modal_hands.py`. It needs `MANO_RIGHT.pkl` (free registration at mano.is.tue.mpg.de, non-commercial). Results: [`experiments/2026-11-16-anatomical-hands.md`](../experiments/2026-11-16-anatomical-hands.md).

Results and the honest finger-quality write-up: [`experiments/2026-11-14-motion-extraction.md`](../experiments/2026-11-14-motion-extraction.md). Nothing here judges whether a sign is linguistically correct; only a fluent signer can.
