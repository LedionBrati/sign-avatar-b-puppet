// The repo root and the small helpers the server modules share (clip dirs, motion dirs, generate-on-use).
// Every default path is relative to the repo root; each one has an env override (lib/config.mjs lists them).

import { closeSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const fromRepo = (...parts) => join(REPO, ...parts);

/** "a,b ; c" -> ["a", "b", "c"] (comma or semicolon separated). */
export const list = (value) => String(value ?? "").split(/[,;]/).map((d) => d.trim()).filter(Boolean);

/** motion_id / gloss from the first 4 KB of a motion file (they come before the frames). null if unreadable. */
export function readMotionHead(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(4096);
    const s = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
    return { motion_id: /"motion_id"\s*:\s*"([^"]+)"/.exec(s)?.[1] ?? null, gloss: /"gloss"\s*:\s*"([^"]+)"/.exec(s)?.[1] ?? null };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
