// Read-only smoke check for the real plan -> catalog -> cleaned motion handoff.
// Usage: node shared/check-playback.mjs PLAN.json [CATALOG.json] [REPOSITORY_ROOT]
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPlayback } from "./contracts.mjs";
import { createMotionLoader } from "./motion-loader.node.mjs";

const [planPath, catalogPath = "catalog/signs.json", root = process.cwd()] = process.argv.slice(2);
if (!planPath) {
  console.error("Usage: node shared/check-playback.mjs PLAN.json [CATALOG.json] [REPOSITORY_ROOT]");
  process.exit(2);
}

const detected = (landmarks) => Array.isArray(landmarks) && landmarks.some((point) => point !== null);
const countFrames = (frames, field) => frames.filter((frame) => detected(frame[field])).length;

try {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const result = await loadPlayback(plan, catalog, createMotionLoader({ root: resolve(root) }));
  if (result.status === "unsupported") {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    const items = result.items.map(({ item_index, motion_id, motion_path, motion }) => ({
      item_index, motion_id, motion_path,
      source: motion.source,
      fps: motion.fps,
      frames: motion.frames.length,
      sampled_duration_s: motion.frames.length / motion.fps,
      dominant_hand: motion.dominant_hand,
      mirrored: motion.mirrored,
      detected_frames: {
        pose: countFrames(motion.frames, "pose"),
        face: countFrames(motion.frames, "face"),
        left_hand: countFrames(motion.frames, "leftHand"),
        right_hand: countFrames(motion.frames, "rightHand"),
      },
    }));
    console.log(JSON.stringify({ status: "ready", caption: result.caption, items,
      nonmanual_markers: result.nonmanual_markers }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
