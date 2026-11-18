"""Download the two pretrained recognizer models into app/recognizer/models/ (gitignored).

    uv run python fetch_models.py            # download what is missing
    uv run python fetch_models.py --from DIR # copy gislr.tflite / fs.tflite / ... from a local folder first
    uv run python fetch_models.py --force    # re-download everything

Files written:
  gislr.tflite             GISLR 1st place (hoyso48), MIT, https://huggingface.co/sign/kaggle-asl-signs-1st-place
  gislr_labels.json        sign_to_prediction_index_map.json (250 signs)
  fs.tflite                ASL Fingerspelling 1st place (Henkel/Hanley), Apache-2.0, cfg_2/fold-1/model.tflite
  fs_args.json             its inference_args.json (selected_columns, 390 = 130 points x xyz)
  fs_chars.json            datamount/character_to_prediction_index.json (59 characters)

The fingerspelling release is a 192 MB zip; we read only the two members we need with HTTP Range
requests (about 41 MB), so the whole zip is never downloaded.
"""

from __future__ import annotations

import argparse
import io
import os
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

MODELS = Path(os.environ.get("RECOGNIZER_MODELS") or Path(__file__).resolve().parent / "models")
HF = "https://huggingface.co/sign/kaggle-asl-signs-1st-place/resolve/main"
FS_ZIP = "https://github.com/ChristofHenkel/kaggle-asl-fingerspelling-1st-place-solution/releases/download/v0.0.1-alpha/weights.zip"
FS_REPO = "https://raw.githubusercontent.com/ChristofHenkel/kaggle-asl-fingerspelling-1st-place-solution/main"
FS_MEMBER_DIR = "cfg_2/fold-1/"

# name -> plain URL (zip members are handled separately)
PLAIN = {
    "gislr.tflite": f"{HF}/model.tflite",
    "gislr_labels.json": f"{HF}/sign_to_prediction_index_map.json",
    "fs_chars.json": f"{FS_REPO}/datamount/character_to_prediction_index.json",
}
ZIPPED = {"fs.tflite": "model.tflite", "fs_args.json": "inference_args.json"}
# Names used by earlier ad-hoc downloads, accepted by --from.
ALIASES = {"gislr.tflite": ["gislr.tflite", "islr.tflite"], "gislr_labels.json": ["gislr_labels.json", "map.json"],
           "fs.tflite": ["fs.tflite"], "fs_args.json": ["fs_args.json"], "fs_chars.json": ["fs_chars.json"]}

UA = {"User-Agent": "flux-recognizer/0.1"}


def get(url: str, headers: dict | None = None) -> bytes:
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


class HttpRangeFile(io.RawIOBase):
    """Read-only seekable file over HTTP Range requests (enough for zipfile)."""

    def __init__(self, url: str):
        req = urllib.request.Request(url, method="HEAD", headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            self.url = r.geturl()  # follow the GitHub -> object storage redirect once
            self.size = int(r.headers["Content-Length"])
        self.pos = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = {0: offset, 1: self.pos + offset, 2: self.size + offset}[whence]
        return self.pos

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        data = get(self.url, {"Range": f"bytes={self.pos}-{self.pos + n - 1}"})
        b[: len(data)] = data
        self.pos += len(data)
        return len(data)


def fetch_zip_members(names: list[str]) -> None:
    raw = HttpRangeFile(FS_ZIP)
    with zipfile.ZipFile(io.BufferedReader(raw, buffer_size=1 << 20)) as z:
        members = {m.filename: m for m in z.infolist()}
        for name in names:
            want = [k for k in members if k.endswith(FS_MEMBER_DIR + ZIPPED[name])]
            if not want:
                sys.exit(f"{FS_MEMBER_DIR}{ZIPPED[name]} not in {FS_ZIP}")
            print(f"  {want[0]} ({members[want[0]].file_size / 1e6:.1f} MB) -> {name}", flush=True)
            with z.open(want[0]) as src, open(MODELS / name, "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="src", type=Path, help="copy existing files from this folder first")
    ap.add_argument("--force", action="store_true", help="re-download even if present")
    a = ap.parse_args()
    MODELS.mkdir(parents=True, exist_ok=True)
    every = [*PLAIN, *ZIPPED]
    if a.force:
        for n in every:
            (MODELS / n).unlink(missing_ok=True)
    if a.src:
        for n in every:
            for alias in ALIASES[n]:
                p = a.src / alias
                if not (MODELS / n).exists() and p.is_file():
                    shutil.copyfile(p, MODELS / n)
                    print(f"copied {p} -> {n}")
    for n, url in PLAIN.items():
        if not (MODELS / n).exists():
            print(f"downloading {n} <- {url}", flush=True)
            (MODELS / n).write_bytes(get(url))
    missing_zip = [n for n in ZIPPED if not (MODELS / n).exists()]
    if missing_zip:
        print(f"reading {', '.join(missing_zip)} from {FS_ZIP} (Range requests)", flush=True)
        fetch_zip_members(missing_zip)
    for n in every:
        print(f"ok {n} {(MODELS / n).stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
