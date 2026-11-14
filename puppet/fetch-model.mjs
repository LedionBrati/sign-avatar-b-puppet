// Download the VRM sample models into puppet/models/ (git-ignored).
//
// Default: VRM1_Constraint_Twist_Sample.vrm, (c) 2022 pixiv Inc., VRM Public License 1.0.
// Its embedded VRM meta: avatarPermission "everyone", commercialUsage "corporation",
// allowRedistribution true, modification "allowModificationRedistribution", creditNotation "unnecessary".
// Optional: Seed-san.vrm, VirtualCast, Inc., VRM Public License 1.0, same permissions but
// creditNotation "required" (credit "Seed-san model by VirtualCast, Inc." if you show it).
// Licence text: https://vrm.dev/licenses/1.0/
//
// Usage: node puppet/fetch-model.mjs [--all]

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "models");
const MODELS = [
  { file: "VRM1_Constraint_Twist_Sample.vrm", url: "https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples/VRM1_Constraint_Twist_Sample/vrm/VRM1_Constraint_Twist_Sample.vrm", fallback: "https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm" },
  { file: "Seed-san.vrm", url: "https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples/Seed-san/vrm/Seed-san.vrm", optional: true },
];

/** print the licence fields embedded in the VRM (glTF JSON chunk) */
function meta(path) {
  const b = readFileSync(path);
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8"));
  const m = json.extensions?.VRMC_vrm?.meta ?? json.extensions?.VRM?.meta ?? {};
  const pick = ["name", "authors", "author", "licenseUrl", "licenseName", "avatarPermission", "commercialUsage", "allowRedistribution", "modification", "creditNotation"];
  return Object.fromEntries(pick.filter((k) => k in m).map((k) => [k, m[k]]));
}

mkdirSync(dir, { recursive: true });
for (const m of MODELS) {
  if (m.optional && !process.argv.includes("--all")) continue;
  const out = join(dir, m.file);
  if (!existsSync(out)) {
    let res = await fetch(m.url);
    if (!res.ok && m.fallback) res = await fetch(m.fallback);
    if (!res.ok) { console.error(`failed to download ${m.file}: HTTP ${res.status}`); process.exitCode = 1; continue; }
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`downloaded ${out}`);
  } else console.log(`already have ${out}`);
  console.log("  licence:", JSON.stringify(meta(out)));
}
