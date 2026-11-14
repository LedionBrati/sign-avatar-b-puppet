#!/usr/bin/env bash
# Crop a signer clip to the avatar's framing: 3:4 portrait, 540x720, 24 fps, no audio.
#
# Usage:
#   ./prepare-clip.sh <input.mp4> <output.mp4> [x_offset]
#
# x_offset = left edge of the crop in the source, in pixels.
# Leave it out to crop from the center. For How2Sign (1280x720) clips we used
# 380 to 410, so the signer's hands never leave the frame. Always check a few
# frames after cropping: fast signs reach further out than you expect.
set -euo pipefail

in="${1:?input clip}"
out="${2:?output clip}"
x="${3:-}"

if [[ -z "$x" ]]; then
  crop="crop=ih*3/4:ih"            # centered
else
  crop="crop=ih*3/4:ih:${x}:0"
fi

ffmpeg -hide_banner -loglevel error -y -i "$in" \
  -vf "fps=24,${crop},scale=540:720,setsar=1" \
  -an -c:v libx264 -crf 16 -preset slow -pix_fmt yuv420p -movflags +faststart "$out"

echo "$out: $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out") s"
