#!/usr/bin/env bash
# Put the cut-out person (from remove-bg.mjs) on the dark wall.
#
# Usage:
#   ./composite.sh <color.mp4> <alpha.mp4> <wall.png> <output.mp4>
#
# Options (environment variables):
#   REMOVE_RED=1   (default) also removes strongly red pixels in the lower part of
#                  the frame. How2Sign signers 3 and 8 sit on a red chair, and the
#                  background remover sometimes keeps a few red bits of it.
#                  Set REMOVE_RED=0 if your clip has no red chair.
#   RED_FROM_Y=620 only pixels below this row (in a 1440-tall frame) are checked,
#                  so lips and skin above it are never touched.
set -euo pipefail

color="${1:?color.mp4}"
alpha="${2:?alpha.mp4}"
wall="${3:?wall.png}"
out="${4:?output.mp4}"
remove_red="${REMOVE_RED:-1}"
red_y="${RED_FROM_Y:-620}"

# Match the wall to the video size.
IFS=x read -r W H < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$color")

if [[ "$remove_red" == "1" ]]; then
  # mask = 0 where a pixel is clearly red (r much bigger than g and b) below RED_FROM_Y, else 255
  e="if(gt(Y,${red_y}*H/1440)*gt(r(X,Y),1.8*g(X,Y)+8)*gt(r(X,Y),1.8*b(X,Y)+8),0,255)"
  alpha_chain="[1]split[c1][c2];[c2]format=gbrp,geq=r='${e}':g='${e}':b='${e}',format=gray,erosion,erosion,erosion,gblur=sigma=1.5[nm];[2]format=gray[a0];[a0][nm]blend=all_mode=multiply[a];[c1][a]alphamerge[fg]"
else
  alpha_chain="[2]format=gray[a];[1][a]alphamerge[fg]"
fi

ffmpeg -hide_banner -loglevel error -y \
  -loop 1 -i "$wall" -i "$color" -i "$alpha" \
  -filter_complex "[0]scale=${W}:-2,crop=${W}:${H},setsar=1,format=rgb24[bg];${alpha_chain};[bg][fg]overlay=shortest=1,format=yuv420p" \
  -r 24 -an -c:v libx264 -crf 15 -preset slow -movflags +faststart "$out"

echo "wrote $out"
