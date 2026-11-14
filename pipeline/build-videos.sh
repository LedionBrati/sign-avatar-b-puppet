#!/usr/bin/env bash
# Build the two shareable videos from the avatar video, the real signer clip
# and the layers from render-layers.mjs.
#
# Usage:
#   ./build-videos.sh <avatar-on-wall.mp4> <real-signer.mp4> <layers-dir> <out-prefix> [loops]
#
# Writes:
#   <out-prefix>-side-by-side.mp4   1920x1080, real signer | avatar, caption below
#   <out-prefix>-phone.mp4          1080x1920, avatar full screen, small real-signer window, caption below
#
# loops = how many times the clip plays (default 2, so people can watch it again).
set -euo pipefail

avatar="${1:?avatar-on-wall.mp4}"
real="${2:?real-signer.mp4}"
layers="${3:?layers dir}"
prefix="${4:?output prefix}"
loops="${5:-2}"
extra=$((loops - 1))
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$avatar")
total=$(echo "$dur * $loops" | bc -l)

# Side by side: two 615x820 panels on the 1920x1080 background.
ffmpeg -hide_banner -loglevel error -y \
  -loop 1 -i "$layers/land.png" -stream_loop "$extra" -i "$real" -stream_loop "$extra" -i "$avatar" \
  -filter_complex "[0]format=yuv420p[bg];[1]scale=615:820,setsar=1[l];[2]scale=615:820,setsar=1[r];[bg][l]overlay=330:80:shortest=1[t];[t][r]overlay=975:80:shortest=1,format=yuv420p" \
  -t "$total" -r 24 -an -c:v libx264 -crf 17 -preset slow -movflags +faststart "${prefix}-side-by-side.mp4"

# Phone: avatar 1080x1440 on top, small real-signer window top right, caption below.
ffmpeg -hide_banner -loglevel error -y \
  -loop 1 -i "$layers/vbg.png" -stream_loop "$extra" -i "$avatar" -loop 1 -i "$layers/vtopA.png" \
  -stream_loop "$extra" -i "$real" -loop 1 -i "$layers/vtopB.png" \
  -filter_complex "[0]format=yuv420p[bg];[1]scale=1080:1440,setsar=1[av];[3]scale=300:400,setsar=1[pip];[bg][av]overlay=0:0:shortest=1[s1];[s1][2]overlay=0:0[s2];[s2][pip]overlay=748:32:shortest=1[s3];[s3][4]overlay=0:0,format=yuv420p" \
  -t "$total" -r 24 -an -c:v libx264 -crf 17 -preset slow -movflags +faststart "${prefix}-phone.mp4"

echo "wrote ${prefix}-side-by-side.mp4 and ${prefix}-phone.mp4"
