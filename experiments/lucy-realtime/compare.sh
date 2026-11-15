#!/usr/bin/env bash
# Build one side-by-side PNG from frames of several videos.
# Usage: compare.sh <out.png> "<label>|<video>|<seconds>|<crop>" ...
#   crop: "lucy" = cut the 720x960 puppet area back out of Lucy's 720x1280 padded frame, "-" = none.
# Example:
#   compare.sh out/cmp/judy-5.62.png "puppet 5.62 s|judy-vrm.mp4|5.62|-" "Recast|generated.mp4|5.62|-" \
#     "Lucy 2.6 loop 1|out/lucy-2-6-judy.mp4|8.234|lucy"
set -euo pipefail
out=$1; shift
tmp=$(mktemp -d)
H=${PANEL_H:-400}
inputs=(); n=0
for spec in "$@"; do
  IFS='|' read -r label video secs crop <<<"$spec"
  vf="scale=-2:$H"
  [ "$crop" = "lucy" ] && vf="crop=720:960:0:160,$vf"
  vf="$vf,drawtext=text='$label':x=8:y=8:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6"
  ffmpeg -v error -y -ss "$secs" -i "$video" -frames:v 1 -vf "$vf" "$tmp/$n.png" 2> >(grep -v Fontconfig >&2)
  inputs+=(-i "$tmp/$n.png"); n=$((n+1))
done
ffmpeg -v error -y "${inputs[@]}" -filter_complex "hstack=inputs=$n" "$out"
rm -rf "$tmp"
