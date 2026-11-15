// Clip sets: one or more dirs, each with manifest.json {MOTION_ID: {gloss, file, frames, seconds, ...}}.
// Later dirs add signs; the first dir wins when two dirs have the same motion_id.
// Only files listed in a manifest AND present on disk are exposed, so a sign is never invented
// and /clips/* can never serve anything outside the manifests.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_CLIPS_DIR = "C:\\Users\\DELL\\Desktop\\sign-avatar-b-puppet\\out\\realtime\\clips";
const FPS = 24;
const LETTER = /^FS_([A-Z])$/;

/** "a,b ; c" -> ["a", "b", "c"] (comma or semicolon separated). */
export function parseClipsDirs(value = process.env.CLIPS_DIR) {
  const dirs = String(value ?? "").split(/[,;]/).map((d) => d.trim()).filter(Boolean);
  return dirs.length ? dirs : [DEFAULT_CLIPS_DIR];
}

const urlPath = (p) => p.split("/").map(encodeURIComponent).join("/");

/**
 * @returns {{ signs: Map<string, Sign>, letters: Map<string, Sign>, files: Map<string, string>, dirs: object[], warnings: string[] }}
 * Sign = { motion_id, gloss, file, path, url, duration_s, dir }
 */
export function loadClipSets(dirs) {
  const signs = new Map(), letters = new Map(), files = new Map(), info = [], warnings = [];
  dirs.forEach((dir, d) => {
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) { warnings.push(`no manifest.json in ${dir}`); info.push({ dir, signs: 0 }); return; }
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
    catch (error) { warnings.push(`bad manifest ${manifestPath}: ${error.message}`); info.push({ dir, signs: 0 }); return; }
    let added = 0;
    for (const [motion_id, e] of Object.entries(manifest ?? {})) {
      if (!e || typeof e.file !== "string" || !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(motion_id)) continue;
      const letter = LETTER.exec(motion_id)?.[1] ?? (/^[A-Z]$/.test(e.letter ?? "") ? e.letter : null);
      if (!letter && typeof e.gloss !== "string") continue;
      const target = letter ? letters : signs;
      if (target.has(letter ?? motion_id)) continue;                  // first dir wins
      const path = isAbsolute(e.file) ? e.file : resolve(dir, e.file);
      if (!existsSync(path) || !statSync(path).isFile()) { warnings.push(`missing clip ${path} (${motion_id})`); continue; }
      // Same file name in an earlier dir -> namespace it by dir index so URLs never collide.
      let rel = e.file.replace(/\\/g, "/").replace(/^\/+/, "");
      if (isAbsolute(e.file) || rel.split("/").includes("..")) rel = path.replace(/\\/g, "/").split("/").pop();
      if (files.has(rel) && files.get(rel) !== path) rel = `${d}/${rel}`;
      files.set(rel, path);
      const seconds = Number(e.seconds) > 0 ? Number(e.seconds) : Number(e.frames) > 0 ? Number(e.frames) / FPS : 0;
      const sign = { motion_id, gloss: letter ?? e.gloss, file: e.file, path, url: `/clips/${urlPath(rel)}`,
        duration_s: Math.round(seconds * 1000) / 1000, dir };
      target.set(letter ?? motion_id, sign);
      added++;
    }
    info.push({ dir, signs: added });
  });
  return { signs, letters, files, dirs: info, warnings };
}
