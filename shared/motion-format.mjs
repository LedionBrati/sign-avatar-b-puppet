// Motion format v1 validator. Keep this module browser-safe: no Node imports.
// Source of truth: motion/FORMAT.md. It checks structure, not ASL correctness.

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value) => finite(value) && value >= 0;
const canonicalId = (value) => typeof value === "string" && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(value);

export class MotionValidationError extends TypeError {
  constructor(issues, label = "Motion format v1") {
    super(`${label} invalid:\n- ${issues.join("\n- ")}`);
    this.name = "MotionValidationError";
    this.issues = issues;
  }
}

function pointSeries(value, name, count, dimensions, issues) {
  if (value === null) return;
  if (!Array.isArray(value) || value.length !== count) {
    issues.push(`${name} must be null or ${count} landmarks`);
    return;
  }
  value.forEach((point, index) => {
    if (point === null) return; // individual landmarks can also be occluded
    if (!Array.isArray(point) || point.length !== dimensions || !point.every(finite)) {
      issues.push(`${name}[${index}] must be null or ${dimensions} finite numbers`);
    } else if (dimensions === 4 && (point[3] < 0 || point[3] > 1)) {
      issues.push(`${name}[${index}] visibility must be 0..1`);
    }
  });
}

/** Validate a raw or cleaned v1 object without changing its coordinates or nulls. */
export function assertMotionV1(motion, { expectedMotionId, requireClean = false, fileStem } = {}) {
  const issues = [];
  if (!object(motion)) throw new MotionValidationError(["root must be an object"]);
  if (motion.version !== 1) issues.push("version must be 1");
  if (!text(motion.name)) issues.push("name must be nonempty");
  if (fileStem !== undefined && motion.name !== fileStem) issues.push(`name must match file stem ${fileStem}`);
  if (motion.motion_id !== null && !canonicalId(motion.motion_id)) issues.push("motion_id must be null or an uppercase canonical ID");
  if (motion.motion_id === null && motion.gloss !== null) issues.push("sentence/reference clip with motion_id:null must have gloss:null");
  if (motion.motion_id !== null && !text(motion.gloss)) issues.push("isolated sign must have a nonempty gloss");
  if (expectedMotionId !== undefined) {
    if (!canonicalId(expectedMotionId)) issues.push("expectedMotionId must be a canonical ID");
    if (motion.motion_id === null) issues.push("sentence/reference clip with motion_id:null cannot satisfy a sign catalog entry");
    else if (motion.motion_id !== expectedMotionId) issues.push(`motion_id ${motion.motion_id} does not match expected ${expectedMotionId}`);
  }
  if (!object(motion.source)) issues.push("source must be an object");
  else {
    for (const field of ["file", "dataset", "license"]) if (!text(motion.source[field])) issues.push(`source.${field} must be nonempty`);
    if (motion.source.signer !== undefined && motion.source.signer !== null && !text(motion.source.signer)) issues.push("source.signer must be a string when known");
    if (!nonnegative(motion.source.start_s)) issues.push("source.start_s must be >=0");
    if (!finite(motion.source.end_s) || motion.source.end_s <= motion.source.start_s) issues.push("source.end_s must be after source.start_s");
  }
  if (!finite(motion.fps) || motion.fps <= 0) issues.push("fps must be positive");
  for (const field of ["width", "height"]) if (!Number.isInteger(motion[field]) || motion[field] <= 0) issues.push(`${field} must be a positive integer`);
  if (!["left", "right", null].includes(motion.dominant_hand)) issues.push("dominant_hand must be left, right or null");
  if (typeof motion.mirrored !== "boolean") issues.push("mirrored must be boolean");
  if (!object(motion.extractor) || !["name", "version", "model"].every((key) => text(motion.extractor[key]))) {
    issues.push("extractor needs name, version and model strings");
  }
  if (typeof motion.cleaned !== "boolean") issues.push("cleaned must be boolean");
  if (motion.cleaned === false && motion.cleanup !== null) issues.push("raw motion must have cleanup:null");
  if (motion.cleaned === true && !object(motion.cleanup)) issues.push("cleaned motion must have a cleanup object");
  if (requireClean && motion.cleaned !== true) issues.push("catalog playback requires cleaned motion");
  if (object(motion.cleanup)) {
    if (motion.cleanup.smoothing !== undefined && !text(motion.cleanup.smoothing)) issues.push("cleanup.smoothing must be nonempty when present");
    if (motion.cleanup.params !== undefined && !object(motion.cleanup.params)) issues.push("cleanup.params must be an object when present");
    if (motion.cleanup.trim !== undefined && (!Array.isArray(motion.cleanup.trim) || motion.cleanup.trim.length !== 2 ||
      !motion.cleanup.trim.every((n) => Number.isInteger(n) && n >= 0) || motion.cleanup.trim[0] > motion.cleanup.trim[1])) {
      issues.push("cleanup.trim must be [startFrame, endFrame]");
    }
    if (motion.cleanup.filled_frames !== undefined && !object(motion.cleanup.filled_frames)) issues.push("cleanup.filled_frames must be an object when present");
  }
  if (!Array.isArray(motion.frames) || motion.frames.length === 0) issues.push("frames must be a nonempty array");
  else motion.frames.forEach((frame, index) => {
    const prefix = `frames[${index}]`;
    if (!object(frame)) { issues.push(`${prefix} must be an object`); return; }
    if (frame.i !== index) issues.push(`${prefix}.i must equal ${index}`);
    if (!nonnegative(frame.t)) issues.push(`${prefix}.t must be >=0 seconds`);
    else if (finite(motion.fps) && motion.fps > 0 && Math.abs(frame.t - index / motion.fps) > 0.5 / motion.fps + 0.0002) {
      issues.push(`${prefix}.t is inconsistent with fps ${motion.fps}`);
    }
    for (const [field, count, dimensions] of [["pose",33,4],["poseWorld",33,3],["face",478,3],
      ["leftHand",21,3],["rightHand",21,3]]) {
      if (!(field in frame)) issues.push(`${prefix}.${field} is required (null when missing)`);
      else pointSeries(frame[field], `${prefix}.${field}`, count, dimensions, issues);
    }
    for (const field of ["leftHandWorld", "rightHandWorld"]) {
      if (field in frame) pointSeries(frame[field], `${prefix}.${field}`, 21, 3, issues);
    }
    if (frame.faceBlendshapes !== undefined && frame.faceBlendshapes !== null) {
      if (!object(frame.faceBlendshapes)) issues.push(`${prefix}.faceBlendshapes must be an object when present`);
      else for (const [name, score] of Object.entries(frame.faceBlendshapes)) {
        if (!text(name) || !finite(score) || score < 0 || score > 1) issues.push(`${prefix}.faceBlendshapes.${name} must score 0..1`);
      }
    }
  });
  if (issues.length) throw new MotionValidationError(issues);
  return motion;
}
