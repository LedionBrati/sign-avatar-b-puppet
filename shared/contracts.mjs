// Runtime contracts between the ASL planner, sign catalog and motion/VRM player.
// Sign-language correctness is a separate, signer-reviewed evaluation.
// This module deliberately contains no generated/transliterated signs or invented motions.

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonempty = (v) => typeof v === "string" && v.trim().length > 0;
const integer = (v) => Number.isInteger(v) && v >= 0;
const canonicalId = (v) => typeof v === "string" && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(v);

function throwErrors(label, errors) {
  if (errors.length) throw new TypeError(label + ":\n- " + errors.join("\n- "));
}

/**
 * Plan contract (shared/INTEGRATION.md):
 * - items are in signing order, including fingerspelling anywhere in the sequence.
 * - nonmanual markers use zero-based INCLUSIVE item spans [from, to].
 * - unknown motions are handled by resolvePlan(), not invented here.
 */
export function assertPlan(plan) {
  const errors = [];
  if (!object(plan)) throw new TypeError("ASL plan must be an object");
  if (!nonempty(plan.input_text)) errors.push("input_text must be nonempty");
  if (!nonempty(plan.caption)) errors.push("caption must be nonempty");
  if (!Array.isArray(plan.items) || plan.items.length === 0) {
    errors.push("items must be a nonempty ordered array");
  }
  const items = Array.isArray(plan.items) ? plan.items : [];
  items.forEach((item, i) => {
    if (!object(item)) { errors.push(`items[${i}] must be an object`); return; }
    if (item.type === "sign") {
      if (!nonempty(item.gloss)) errors.push(`items[${i}].gloss required`);
      if (!canonicalId(item.motion_id)) errors.push(`items[${i}].motion_id must be an uppercase canonical ID`);
      if (item.hold_ms !== undefined && !integer(item.hold_ms)) {
        errors.push(`items[${i}].hold_ms must be a nonnegative integer`);
      }
    } else if (item.type === "fingerspell") {
      if (typeof item.word !== "string" || !/^[A-Z]+$/.test(item.word)) {
        errors.push(`items[${i}].word must contain A-Z uppercase letters`);
      }
    } else {
      errors.push(`items[${i}].type must be sign or fingerspell`);
    }
  });
  if (!Array.isArray(plan.nonmanual_markers)) errors.push("nonmanual_markers must be an array");
  (Array.isArray(plan.nonmanual_markers) ? plan.nonmanual_markers : []).forEach((mark, i) => {
    if (!object(mark) || !nonempty(mark.type) ||
        !integer(mark.from) || !integer(mark.to) ||
        mark.from > mark.to || mark.to >= items.length) {
      errors.push(`nonmanual_markers[${i}] needs type and inclusive span 0 <= from <= to < items.length`);
    }
  });
  if (!Array.isArray(plan.unsupported_tokens) ||
      !plan.unsupported_tokens.every(nonempty)) {
    errors.push("unsupported_tokens must be an array of nonempty strings");
  }
  throwErrors("Invalid ASL plan", errors);
  return plan;
}

/**
 * Catalog is the common identifier mapping for both signing and recognition.
 * A "verified" item requires provenance and an actual motion asset reference.
 * We do not claim the referenced asset has been inspected by this function.
 */
export function assertCatalog(catalog) {
  const errors = [];
  if (!object(catalog)) throw new TypeError("Catalog must be an object");
  if (catalog.schema_version !== 1) errors.push("schema_version must be 1");
  if (!Array.isArray(catalog.signs)) errors.push("signs must be an array");
  const signs = Array.isArray(catalog.signs) ? catalog.signs : [];
  const ids = new Set();
  for (const [i, sign] of signs.entries()) {
    if (!object(sign)) { errors.push(`signs[${i}] must be an object`); continue; }
    if (!canonicalId(sign.id)) errors.push(`signs[${i}].id must be an uppercase canonical ID`);
    else if (ids.has(sign.id)) errors.push(`duplicate sign ID: ${sign.id}`);
    else ids.add(sign.id);
    if (!nonempty(sign.gloss)) errors.push(`signs[${i}].gloss required`);
    if (!["experimental", "verified", "unsupported"].includes(sign.status)) {
      errors.push(`signs[${i}].status invalid`);
    }
    for (const key of ["sense", "recognizer_label", "motion_path", "source", "source_url", "signer", "license"]) {
      if (sign[key] !== undefined && !nonempty(sign[key])) errors.push(`signs[${i}].${key} must be nonempty if present`);
    }
    if (sign.letter !== undefined && !/^[A-Z]$/.test(sign.letter)) {
      errors.push(`signs[${i}].letter must be one uppercase A-Z letter`);
    }
    if (nonempty(sign.motion_path) &&
        (sign.motion_path.startsWith("/") || sign.motion_path.split("/").includes("..") || /^[a-z]+:/i.test(sign.motion_path))) {
      errors.push(`signs[${i}].motion_path must be a project-relative path`);
    }
    if (sign.status === "verified") {
      for (const key of ["motion_path", "source", "license"]) {
        if (!nonempty(sign[key])) errors.push(`verified sign ${sign.id} missing ${key}`);
      }
    }
  }
  if (catalog.fingerspelling !== undefined) {
    if (!object(catalog.fingerspelling)) errors.push("fingerspelling must map uppercase letters to catalog IDs");
    else {
      for (const [letter, signId] of Object.entries(catalog.fingerspelling)) {
        if (!/^[A-Z]$/.test(letter) || !nonempty(signId) || !ids.has(signId)) {
          errors.push(`invalid fingerspelling mapping for ${letter}`);
        } else if (signs.find((sign) => sign?.id === signId)?.letter !== letter) {
          errors.push(`fingerspelling ${letter} must map to an entry with letter ${letter}`);
        }
      }
    }
  }
  throwErrors("Invalid sign catalog", errors);
  return catalog;
}

/** Recognition labels can be ambiguous; never guess a sense from one label. */
export function lookupRecognizerLabel(label, catalog) {
  assertCatalog(catalog);
  if (!nonempty(label)) throw new TypeError("recognizer label must be nonempty");
  const candidates = catalog.signs.filter((sign) => sign.recognizer_label === label)
    .map(({ id, gloss, sense, status }) => ({ id, gloss, sense, status }));
  if (candidates.length === 0) return { status: "unknown", label };
  if (candidates.length > 1) return { status: "ambiguous", label, candidates };
  return { status: "matched", label, sign: candidates[0] };
}

/**
 * Resolve a plan against only verified, explicitly registered assets.
 * Never silently replace missing ASL motions with arbitrary gestures.
 * 'resolvable' means references are in the manifest, NOT that the files or ASL
 * semantics have been independently validated.
 */
export function resolvePlan(plan, catalog) {
  assertPlan(plan);
  assertCatalog(catalog);
  const byId = new Map(catalog.signs.map((sign) => [sign.id, sign]));
  const sequence = [], blocked = [];
  const append = (id, itemIndex, details = {}) => {
    const sign = byId.get(id);
    if (!sign || sign.status !== "verified" || !nonempty(sign.motion_path)) {
      const code = !sign ? "unknown_sign" : sign.status === "unsupported" ? "unsupported_sign" : "unverified_motion";
      blocked.push({ item_index: itemIndex, motion_id: id, code, reason: "No verified motion asset in catalog" });
      return;
    }
    sequence.push({ item_index: itemIndex, motion_id: id, motion_path: sign.motion_path, ...details });
  };
  plan.items.forEach((item, index) => {
    if (item.type === "sign") {
      const listed = byId.get(item.motion_id);
      if (listed && listed.gloss !== item.gloss) {
        blocked.push({ item_index: index, motion_id: item.motion_id, code: "gloss_mismatch",
          reason: `Plan gloss ${item.gloss} does not match catalog gloss ${listed.gloss}` });
        return;
      }
      append(item.motion_id, index, { type: "sign", gloss: item.gloss, hold_ms: item.hold_ms ?? 0 });
      return;
    }
    // An entire fingerspelled word is atomic: never output a partial word as valid.
    const letters = [...item.word];
    const mapped = letters.map((letter) => catalog.fingerspelling?.[letter]);
    const missing = mapped.flatMap((id, i) =>
      !id || byId.get(id)?.status !== "verified" || !nonempty(byId.get(id)?.motion_path)
        ? [letters[i]] : []);
    if (missing.length) {
      blocked.push({ item_index: index, word: item.word, code: "missing_fingerspelling",
        reason: "Missing verified fingerspelling letters: " + [...new Set(missing)].join(", ") });
      return;
    }
    mapped.forEach((id, letter_index) => append(id, index, { type: "fingerspell", letter: letters[letter_index], letter_index }));
  });
  for (const token of plan.unsupported_tokens) {
    blocked.push({ token, code: "unsupported_token", reason: "Unsupported English token; do not invent a sign" });
  }
  // A renderer must never accidentally play a valid prefix of an unsupported plan.
  const playable = blocked.length === 0 ? sequence : [];
  const markers = blocked.length === 0 ? plan.nonmanual_markers.map((mark) => {
    const from_sequence = playable.findIndex((item) => item.item_index === mark.from);
    const to_sequence = playable.findLastIndex((item) => item.item_index === mark.to);
    return { ...mark, from_sequence, to_sequence };
  }) : [];
  return {
    resolvable: blocked.length === 0,
    sequence: playable,
    blocked,
    nonmanual_markers: markers,
    caption: plan.caption,
    input_text: plan.input_text,
  };
}

/** Frontend boundary: either all ordered motion references are ready, or none are. */
export function preparePlayback(plan, catalog) {
  const result = resolvePlan(plan, catalog);
  if (!result.resolvable) return { status: "unsupported", caption: result.caption,
    input_text: result.input_text, blocked: result.blocked };
  return { status: "ready", caption: result.caption, input_text: result.input_text,
    items: result.sequence, nonmanual_markers: result.nonmanual_markers };
}

/**
 * Optional engine boundary. loadMotion(path, item) is supplied by Nikos's motion
 * package or Ledi's app; this module does not define or fabricate frame data.
 */
export async function loadPlayback(plan, catalog, loadMotion) {
  const request = preparePlayback(plan, catalog);
  if (request.status !== "ready") return request;
  if (typeof loadMotion !== "function") throw new TypeError("loadMotion must be a function");
  const items = [];
  for (const item of request.items) {
    try {
      const motion = await loadMotion(item.motion_path, item);
      if (motion == null) throw new Error("loader returned no motion");
      items.push({ ...item, motion });
    } catch (error) {
      return { status: "unsupported", caption: request.caption, input_text: request.input_text,
        blocked: [{ item_index: item.item_index, motion_id: item.motion_id,
          code: "motion_load_failed", reason: `Motion asset could not be loaded: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  }
  return { ...request, items };
}
