// The renderer is a parameter: any branch or commit of any local clone. We export `git archive <sha> puppet` (read
// only: the other clone's index and worktree are never touched, and uncommitted edits there are NOT included), so
// Modal renders with exactly that commit. modal_render_prod.py uploads the exported folder.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const git = (repo, args, opts = {}) => execFileSync("git", ["-C", repo, ...args], { maxBuffer: 1 << 30, windowsHide: true, ...opts });

/** ref -> full sha (throws if the ref does not exist in that clone). */
export function resolveRef(repo, ref) {
  return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).toString().trim();
}

/** Does the renderer at `sha` know `--placement`? (the IK hand placement from fix/hand-placement) */
export function supportsPlacement(repo, sha) {
  try { return git(repo, ["show", `${sha}:puppet/render.mjs`]).toString().includes("--placement"); } catch { return false; }
}

/** Minimal ustar / pax reader for `git archive --format=tar` output. Returns [{path, type, data}]. */
export function untar(buf) {
  const out = [];
  let off = 0, pax = null;
  const str = (a, b) => buf.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const name = str(off, off + 100), size = parseInt(str(off + 124, off + 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48), prefix = str(off + 345, off + 500);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "g") continue;                                   // global pax header (git puts the commit id here)
    if (type === "x") {                                           // per-file pax header: long path
      pax = {};
      for (const line of data.toString("utf8").split("\n")) { const m = /^\d+ ([^=]+)=(.*)$/.exec(line); if (m) pax[m[1]] = m[2]; }
      continue;
    }
    const path = pax?.path ?? (prefix ? `${prefix}/${name}` : name);
    pax = null;
    out.push({ path, type: type === "5" ? "dir" : type === "0" || type === "7" ? "file" : type === "2" ? "symlink" : "other", data });
  }
  return out;
}

/**
 * Export puppet/ at `ref` from `repo` into <root>/<sha12>/puppet (cached per sha) with a RENDERER_SHA file.
 * @returns {{sha, dir, repo, ref}}
 */
export function exportRenderer({ repo, ref, root }) {
  const sha = resolveRef(repo, ref);
  const base = join(root, sha.slice(0, 12)), dir = join(base, "puppet");
  if (!existsSync(join(dir, "RENDERER_SHA"))) {
    const tmp = `${base}.part`;
    rmSync(tmp, { recursive: true, force: true });
    const entries = untar(git(repo, ["archive", "--format=tar", sha, "puppet"]));
    for (const e of entries) {
      const p = normalize(join(tmp, e.path));
      if (!p.startsWith(normalize(tmp))) throw new Error(`unsafe path in archive: ${e.path}`);
      if (e.type === "dir") mkdirSync(p, { recursive: true });
      else if (e.type === "file") { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, e.data); }
    }
    if (!existsSync(join(tmp, "puppet", "render.mjs"))) throw new Error(`${ref} (${sha}) has no puppet/render.mjs`);
    writeFileSync(join(tmp, "puppet", "RENDERER_SHA"), `${sha}\n`);
    rmSync(base, { recursive: true, force: true });
    renameSync(tmp, base);
  }
  return { sha, dir, repo, ref };
}
