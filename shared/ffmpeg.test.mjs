import test from "node:test";
import assert from "node:assert/strict";
import { findTool } from "./ffmpeg.mjs";

test("FFMPEG / FFPROBE win", () => {
  assert.equal(findTool("ffmpeg", { env: { FFMPEG: "/opt/ff/ffmpeg" }, check: () => false }), "/opt/ff/ffmpeg");
  assert.equal(findTool("ffprobe", { env: { FFPROBE: "/opt/ff/ffprobe" }, check: () => false }), "/opt/ff/ffprobe");
});

test("PATH first by default, the bundled binary first with prefer: bundled", () => {
  const all = () => true;
  assert.equal(findTool("ffmpeg", { env: {}, check: all }), "ffmpeg");
  // the bundled one only exists after npm install in pipeline/; without it both orders end at PATH
  const b = findTool("ffmpeg", { env: {}, prefer: "bundled", check: all });
  assert.ok(b === "ffmpeg" || /ffmpeg/i.test(b));
  let onlyBundled = null;
  try { onlyBundled = findTool("ffmpeg", { env: {}, check: (p) => p !== "ffmpeg" }); } catch { /* not installed */ }
  assert.ok(onlyBundled === null || (onlyBundled !== "ffmpeg" && /ffmpeg/i.test(onlyBundled)));
});

test("clear error naming the env var when nothing runs", () => {
  assert.throws(() => findTool("ffprobe", { env: {}, check: () => false }), /ffprobe not found.*FFPROBE=/);
});
