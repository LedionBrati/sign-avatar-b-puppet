"""Download the MediaPipe holistic landmarker model into motion/models/ (gitignored).

    uv run python fetch_model.py
"""
from common import MODEL_PATH, ensure_model

if __name__ == "__main__":
    p = ensure_model()
    print(f"{p} ({p.stat().st_size / 1e6:.1f} MB)")
    assert p == MODEL_PATH
