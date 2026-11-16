// Build puppet/models/signer.glb from scratch: download MPFB (MakeHuman for Blender) and the MakeHuman CC0
// system assets once into a cache folder, then run build_avatar.py in headless Blender. Free, about 2 minutes
// (330 MB of downloads the first time). Nothing is installed into your own Blender profile.
//
//   node puppet/avatar/build.mjs [--blender PATH] [--cache DIR] [--hair long01] [--out puppet/models/signer.glb]
//
// Blender: --blender, $BLENDER, or the default Windows / macOS / Linux install paths (4.2+ needed for MPFB 2).
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, fb) => { const i = argv.indexOf(`--${n}`); return i === -1 ? fb : argv[i + 1]; };
const cache = resolve(opt("cache", join(tmpdir(), "signer-avatar-build")));
const out = resolve(opt("out", join(here, "..", "models", "signer.glb")));
const hair = opt("hair", "long01");

const MPFB = "https://extensions.blender.org/download/sha256:c075b3e9b94b8e5556a5f03f4653602d02ea306de08126e8f55ed6dee28a2dad/add-on-mpfb-v2.0.18.zip";
const ASSETS = "http://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip";

function findBlender() {
  const c = [opt("blender"), process.env.BLENDER,
    ...["4.5", "4.4", "4.3", "4.2"].map((v) => `C:/Program Files/Blender Foundation/Blender ${v}/blender.exe`),
    "/Applications/Blender.app/Contents/MacOS/Blender", "/usr/bin/blender", "/snap/bin/blender"].filter(Boolean);
  const hit = c.find((p) => existsSync(p));
  if (!hit) { console.error("Blender not found: pass --blender PATH or set BLENDER"); process.exit(1); }
  return hit;
}

async function download(url, file) {
  if (existsSync(file)) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file + ".part"));
  execFileSync(process.platform === "win32" ? "cmd" : "mv", process.platform === "win32" ? ["/c", "move", "/y", file + ".part", file] : [file + ".part", file]);
}

mkdirSync(cache, { recursive: true });
const blender = findBlender();
const mpfbZip = join(cache, "mpfb.zip"), assetsZip = join(cache, "makehuman_system_assets_cc0.zip");
await download(MPFB, mpfbZip);
await download(ASSETS, assetsZip);
const assets = join(cache, "mh");
if (!existsSync(join(assets, "skins"))) {
  mkdirSync(assets, { recursive: true });
  console.log("unpacking assets");
  execFileSync("tar", ["-xf", assetsZip, "-C", assets, "skins/young_caucasian_female", "eyes", "eyebrows/eyebrow001", "eyelashes/eyelashes01", "hair"], { stdio: "inherit" });
}
// MPFB goes into a private Blender user folder, never the user's own profile
const userRes = join(cache, "blender_user");
const env = { ...process.env, BLENDER_USER_RESOURCES: userRes };
if (!existsSync(join(userRes, "extensions", "user_default", "mpfb"))) {
  execFileSync(blender, ["--background", "--factory-startup", "--command", "extension", "install-file", "-r", "user_default", "-e", mpfbZip], { env, stdio: "inherit" });
}
mkdirSync(dirname(out), { recursive: true });
execFileSync(blender, ["--background", "--python", join(here, "build_avatar.py"), "--", "--assets", assets, "--hair", hair, "--out", out], { env, stdio: "inherit" });
console.log(`wrote ${out}`);
