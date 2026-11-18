#!/usr/bin/env bash
# Needs bash (Git Bash on Windows). Not on the runtime path.
# Extract -> clean -> report for the 4 How2Sign reference clips into out/motion/.
# Usage (from the repo root or anywhere): bash motion/run_how2sign.sh [clip ...]
# An existing .raw.json is reused (extraction is the slow step); FORCE=1 re-extracts.
set -euo pipefail
cd "$(dirname "$0")"
OUT=../out/motion
mkdir -p "$OUT"
clips=("$@"); [ ${#clips[@]} -eq 0 ] && clips=(judy travis dave floyd)
for c in "${clips[@]}"; do
  case $c in judy|travis) signer=3 ;; dave|floyd) signer=5 ;; *) signer= ;; esac
  src=../references/how2sign/$c.mp4
  if [ -n "${FORCE:-}" ] || [ ! -f "$OUT/$c.raw.json" ]; then
    uv run python extract.py "$src" --out "$OUT/$c.raw.json" --dataset How2Sign --license "CC BY-NC 4.0" \
      ${signer:+--signer $signer} 2>/dev/null | tee "$OUT/$c.extract.log"
  fi
  uv run python clean.py "$OUT/$c.raw.json" --out "$OUT/$c.clean.json"
  uv run python report.py "$OUT/$c.raw.json" "$OUT/$c.clean.json" --video "$src" \
    --out-dir "$OUT/$c-report" --stats "$OUT/$c.extract.log" 2>/dev/null
done
