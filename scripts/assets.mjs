#!/usr/bin/env node
// Runtime data that is not in git: sign clips, the 3D signer, the recognizer's template bank. They are built from
// datasets with non-commercial licences (see README "Licences and data") and published as GitHub Release assets.
//
//   node scripts/assets.mjs fetch          download + unpack the core pack (clips, signer, recognizer extras)
//   node scripts/assets.mjs fetch --3d     also the 3D signer's motion library (large)
//   node scripts/assets.mjs fetch --from <dir-or-url>   use a mirror / a folder holding the .tar.gz files
//   node scripts/assets.mjs fetch --force  re-download even if already unpacked
//   node scripts/assets.mjs pack [--3d]    maintainers: build the packs from your local out/ etc. into dist/assets/,
//                                          then upload them to the release named in scripts/assets.json
//
// Packs are .tar.gz with repo-relative paths, unpacked with the system `tar` (built into Windows 10+, macOS, Linux).

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { REPO, fail, ok, run, step, warn } from "./lib.mjs";

const MANIFEST = join(REPO, "scripts", "assets.json");
const DIST = join(REPO, "dist", "assets");
const STAMPS = join(REPO, "out", ".assets");

const manifest = () => JSON.parse(readFileSync(MANIFEST, "utf8"));
const stamp = (a) => join(STAMPS, `${a.name}-${a.sha256 ?? "unpublished"}`);

async function sha256(file) {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0, shown = -1;
  const body = Readable.fromWeb(res.body);
  body.on("data", (c) => {
    got += c.length;
    const pct = total ? Math.floor((got / total) * 20) * 5 : -1;
    if (pct !== shown && process.stdout.isTTY) { shown = pct; process.stdout.write(`\r  ${(got / 1e6).toFixed(0)} MB${total ? ` / ${(total / 1e6).toFixed(0)} MB (${pct}%)` : ""}   `); }
  });
  const part = `${dest}.part`;
  await pipeline(body, createWriteStream(part));
  if (process.stdout.isTTY) process.stdout.write("\n");
  renameSync(part, dest);
}

async function fetchAssets(args) {
  const m = manifest();
  const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : process.env.FLUX_ASSETS_FROM;
  const want = m.assets.filter((a) => !a.optional || (a.name === "motion" && args.includes("--3d")));
  mkdirSync(DIST, { recursive: true });
  mkdirSync(STAMPS, { recursive: true });
  for (const a of want) {
    step(`Assets: ${a.name} (${a.description})`);
    if (!a.sha256) { warn(`${a.file} has not been published yet (scripts/assets.json has no sha256); skipping`); continue; }
    if (existsSync(stamp(a)) && !args.includes("--force")) { ok(`already unpacked (${a.file})`); continue; }
    const local = join(DIST, a.file);
    if (!existsSync(local) || (await sha256(local)) !== a.sha256) {
      if (from && existsSync(join(from, a.file))) {
        await pipeline(createReadStream(join(from, a.file)), createWriteStream(local));
      } else {
        const base = from ?? `https://github.com/${m.repo}/releases/download/${m.release}`;
        console.log(`  downloading ${base}/${a.file} (${(a.bytes / 1e6).toFixed(0)} MB)`);
        await download(`${base}/${a.file}`, local);
      }
      const got = await sha256(local);
      if (got !== a.sha256) { rmSync(local, { force: true }); throw new Error(`${a.file}: checksum mismatch (got ${got.slice(0, 12)}..., want ${a.sha256.slice(0, 12)}...)`); }
    }
    ok(`checksum ok, unpacking into the repo`);
    // Repo-relative archive path + cwd: GNU tar would read "C:\..." as a remote host.
    if (!run(`tar -xzf dist/assets/${a.file}`).ok) throw new Error(`could not unpack ${a.file} (is tar on PATH?)`);
    writeFileSync(stamp(a), new Date().toISOString());
    ok(`${a.name} ready`);
  }
}

async function pack(args) {
  const m = manifest();
  const want = m.assets.filter((a) => !a.optional || (a.name === "motion" && args.includes("--3d")));
  mkdirSync(DIST, { recursive: true });
  for (const a of want) {
    step(`Pack: ${a.name}`);
    const missing = a.paths.filter((p) => !existsSync(join(REPO, p)));
    if (missing.length) throw new Error(`missing locally: ${missing.join(", ")}`);
    const list = join(DIST, `${a.name}.files.txt`);
    // Directories with an `include` glob list only matching files (the motion dirs hold far more than the player reads).
    const files = a.paths.flatMap((p) => (a.include && statSync(join(REPO, p)).isDirectory() ? listMatching(p, a.include) : [p]));
    writeFileSync(list, files.join("\n") + "\n");
    if (!run(`tar -czf dist/assets/${a.file} -T dist/assets/${a.name}.files.txt`).ok) throw new Error(`tar failed for ${a.file}`);
    const out = join(DIST, a.file);
    a.sha256 = await sha256(out);
    a.bytes = statSync(out).size;
    ok(`${a.file}: ${(a.bytes / 1e6).toFixed(1)} MB, sha256 ${a.sha256.slice(0, 12)}...`);
  }
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
  ok(`scripts/assets.json updated. Upload dist/assets/*.tar.gz to the "${m.release}" release, then commit scripts/assets.json.`);
}

/** Files under dir (repo-relative, forward slashes) matching any glob: `*` within a folder, `**\/` any depth. */
function listMatching(dir, patterns) {
  const res = patterns.map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\0").replace(/\*/g, "[^/]*").replaceAll("\0", "(?:.*/)?")}$`));
  return readdirSync(join(REPO, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(join(REPO, dir).length + 1).replaceAll("\\", "/"))
    .filter((rel) => res.some((re) => re.test(rel)))
    .sort()
    .map((rel) => `${dir}/${rel}`);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "fetch") await fetchAssets(args);
  else if (cmd === "pack") await pack(args);
  else { console.log("usage: node scripts/assets.mjs fetch [--3d] [--force] [--from <dir-or-url>] | pack [--3d]"); process.exit(cmd ? 1 : 0); }
} catch (e) {
  fail(e.message);
  process.exit(1);
}
