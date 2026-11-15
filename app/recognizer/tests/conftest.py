import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from recognizer import MODELS_DIR  # noqa: E402

HAVE_MODELS = all((MODELS_DIR / f).exists() for f in ("gislr.tflite", "gislr_labels.json", "fs.tflite", "fs_args.json", "fs_chars.json"))
needs_models = pytest.mark.skipif(not HAVE_MODELS, reason="run fetch_models.py first")


@pytest.fixture(scope="session")
def rec():
    if not HAVE_MODELS:
        pytest.skip("run fetch_models.py first")
    from recognizer import Recognizer

    return Recognizer()
