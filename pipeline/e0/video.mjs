import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { ffmpegPath, ffprobePath } from "../../shared/ffmpeg.mjs";

const exec = promisify(execFile);
// The bundled ffmpeg-static / @ffprobe-installer binaries first (drawtext below), unless FFMPEG / FFPROBE are set.
const BUNDLED = { prefer: "bundled" };
const ratio = (value) => {
  const [n, d = "1"] = String(value).split("/").map(Number);
  return n / d;
};
const gcd = (a, b) => b ? gcd(b, a % b) : a;

export async function probeVideo(file) {
  const path = resolve(file);
  if (extname(path).toLowerCase() !== ".mp4") throw new Error(`Expected an MP4: ${path}`);
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size === 0) throw new Error(`Empty or non-file MP4: ${path}`);
  const { stdout } = await exec(ffprobePath(BUNDLED), ["-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,duration,sample_aspect_ratio",
    "-show_entries", "format=duration", "-of", "json", path], { maxBuffer: 2_000_000 });
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  if (!stream) throw new Error(`No video stream: ${path}`);
  const width = Number(stream.width), height = Number(stream.height);
  const fps = ratio(stream.avg_frame_rate === "0/0" ? stream.r_frame_rate : stream.avg_frame_rate);
  const duration = Number(stream.duration ?? data.format?.duration);
  const frameCount = Number(stream.nb_read_frames ?? stream.nb_frames);
  if (![width, height, fps, duration, frameCount].every(Number.isFinite) ||
      width < 1 || height < 1 || fps <= 0 || duration <= 0 || frameCount < 1) {
    throw new Error(`Incomplete video metadata: ${path}`);
  }
  const divisor = gcd(width, height);
  return { path, bytes: fileStat.size, codec: stream.codec_name, width, height,
    fps: Number(fps.toFixed(4)), duration_seconds: Number(duration.toFixed(3)), frame_count: frameCount,
    aspect_ratio: `${width / divisor}:${height / divisor}`,
    display_aspect: Number((width / height * (stream.sample_aspect_ratio && stream.sample_aspect_ratio !== "0:1"
      ? ratio(stream.sample_aspect_ratio.replace(":", "/")) : 1)).toFixed(4)),
    sample_aspect_ratio: stream.sample_aspect_ratio ?? "1:1" };
}

export async function makeComparison(source, puppet, generated, output) {
  const labels = ["Original signer", "Puppet", "Generated avatar"];
  const filter = [0, 1, 2].map((i) =>
    `[${i}:v]scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2,setsar=1,drawtext=text='${labels[i]}':fontcolor=white:fontsize=26:box=1:boxcolor=black@0.65:boxborderw=9:x=18:y=18[v${i}]`).join(";") +
    ";[v0][v1][v2]xstack=inputs=3:layout=0_0|640_0|1280_0,format=yuv420p[out]";
  await exec(ffmpegPath(BUNDLED), ["-hide_banner", "-loglevel", "error", "-y", "-i", source,
    "-i", puppet, "-i", generated, "-filter_complex", filter, "-map", "[out]",
    "-shortest", "-an", "-r", "24", "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", output],
  { maxBuffer: 2_000_000 });
  return output;
}
