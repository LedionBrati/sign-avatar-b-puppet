// Node file adapter for loadPlayback(plan, catalog, loadMotion).
import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { assertCatalog } from "./contracts.mjs";
import { assertMotionV1, MotionValidationError } from "./motion-format.mjs";

const canonicalId = (value) => typeof value === "string" && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(value);

/** Return a loadMotion(path, item) callback; it preserves the v1 JSON as-is. */
export function createMotionLoader({ root = process.cwd() } = {}) {
  const projectRoot = resolve(root);
  return async (motionPath, item) => {
    if (!canonicalId(item?.motion_id)) throw new MotionValidationError(["playback item needs a canonical motion_id"]);
    if (typeof motionPath !== "string" || !motionPath.endsWith(".clean.json")) {
      throw new MotionValidationError(["verified sign playback requires a .clean.json path"]);
    }
    if (isAbsolute(motionPath)) throw new MotionValidationError(["motion path must be project-relative"]);
    const candidate = resolve(projectRoot, motionPath);
    const within = relative(projectRoot, candidate);
    if (within.startsWith(`..${sep}`) || within === ".." || within.startsWith(sep)) {
      throw new MotionValidationError(["motion path escapes project root"]);
    }
    let actualRoot;
    let actual;
    try {
      actualRoot = await realpath(projectRoot);
      actual = await realpath(candidate);
    } catch (error) {
      throw new MotionValidationError([`cannot access motion ${motionPath}: ${error.message}`]);
    }
    const actualWithin = relative(actualRoot, actual);
    if (actualWithin.startsWith(`..${sep}`) || actualWithin === ".." || actualWithin.startsWith(sep)) {
      throw new MotionValidationError(["motion symlink escapes project root"]);
    }
    let motion;
    try { motion = JSON.parse(await readFile(actual, "utf8")); }
    catch (error) { throw new MotionValidationError([`cannot read JSON ${motionPath}: ${error.message}`]); }
    const fileStem = basename(motionPath, ".clean.json");
    assertMotionV1(motion, { expectedMotionId: item.motion_id, requireClean: true, fileStem });
    if (item.gloss !== undefined && motion.gloss !== item.gloss) {
      throw new MotionValidationError([`gloss ${motion.gloss} does not match planned ${item.gloss}`]);
    }
    return motion;
  };
}

/** Audit every verified manifest entry before claiming a playable catalog. */
export async function auditVerifiedCatalog(catalog, options = {}) {
  assertCatalog(catalog);
  const loader = createMotionLoader(options);
  const failures = [];
  let checked = 0;
  for (const sign of catalog.signs.filter((entry) => entry.status === "verified")) {
    checked++;
    try { await loader(sign.motion_path, { motion_id: sign.id, gloss: sign.gloss }); }
    catch (error) { failures.push({ id: sign.id, motion_path: sign.motion_path, error: error.message }); }
  }
  return { valid: failures.length === 0, checked, failures };
}
