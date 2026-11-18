#!/usr/bin/env bash
# Needs bash (Git Bash on Windows). Not on the runtime path.
# The full Judy demo from 14 Nov 2026, as one script.
# Real How2Sign clip -> crop -> Recast into our avatar -> remove background
# -> dark wall -> caption -> side-by-side + phone videos.
#
# Run from the repo root:  FAL_KEY=... ./examples/judy.sh
# Costs a little fal credit (1 Recast at 1080P + 1 background removal).
# Takes about 3 to 4 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p out/judy
(cd pipeline && npm install --silent)

# 1. The reference clip is already cropped (references/how2sign/judy.mp4).
#    To crop a new one:  ./pipeline/prepare-clip.sh raw.mp4 references/how2sign/new.mp4 380

# 2. Recast the signer into our avatar (same frame count as the source).
node pipeline/recast.mjs --video references/how2sign/judy.mp4 \
  --avatar assets/avatar/avatar-main.jpg --out out/judy/recast.mp4 --resolution 1080P

# 3. Cut her out (color.mp4 + alpha.mp4).
node pipeline/remove-bg.mjs --video out/judy/recast.mp4 --out-dir out/judy/matte

# 4. Put her on the dark wall (also removes the leftover red chair).
./pipeline/composite.sh out/judy/matte/color.mp4 out/judy/matte/alpha.mp4 \
  assets/avatar/wall-plate.jpg out/judy/avatar-on-wall.mp4

# 5. Caption, labels and credit as PNG layers.
node pipeline/render-layers.mjs --out-dir out/judy/layers \
  --text "Hi, I'm Judy Carrier with Jewels by Park Lane and I'm going to tell you how to clean your sterling silver jewelry."

# 6. Final videos.
./pipeline/build-videos.sh out/judy/avatar-on-wall.mp4 references/how2sign/judy.mp4 out/judy/layers out/judy/judy
