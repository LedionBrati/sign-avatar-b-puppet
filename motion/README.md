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
| `tests/` | pytest on synthetic data for the pure functions. |

Results and the honest finger-quality write-up: [`experiments/2026-11-14-motion-extraction.md`](../experiments/2026-11-14-motion-extraction.md). Nothing here judges whether a sign is linguistically correct; only a fluent signer can.
