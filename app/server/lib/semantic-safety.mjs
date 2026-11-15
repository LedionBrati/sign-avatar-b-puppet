// Conservative playback decision for the existing translator and clip manifest.
// This is an engineering fidelity check, not ASL grammar or signer certification.
import { assertPlan } from "../../../shared/contracts.mjs";
import { glossKey, tokenize } from "../../../translate/rules.mjs";

const HOMOGRAPHS = new Set(["right", "bank", "fine", "broke", "left"]);
const NEGATIONS = new Set(["not", "never", "no", "cannot"]);
const NEGATING_GLOSSES = new Set(["not", "never", "no", "do not want", "do not know", "do not like", "not yet", "can not"]);
const HIGH_RISK_DROPS = new Set(["it", "this", "that", "these", "those", "all", "only", "except", "without", "before", "after", "more", "less"]);
const GENDERED = new Set(["husband", "wife", "man", "woman", "male", "female"]);
const NUMBER_WORDS = new Set(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "hundred", "thousand"]);
const SIGN_METHODS = new Set(["exact", "phrase", "lemma", "synonym", "semantic"]);
const actions = {
  unsupported_token: "Use the full English caption until every meaning-bearing word has a supported sign.",
  missing_clip: "Supply the matching clip or use the full English caption.",
  missing_fingerspelling: "Supply every letter clip or use the full English caption.",
  unrepresented_negation: "Supply a verified negating sign or use the full English caption.",
  numerical_meaning: "Confirm the exact number or time and supply matching signing assets.",
  dropped_meaning: "Review and explicitly represent this word before signing.",
  ambiguous_sense: "Confirm the intended sense and select a sense-specific signing asset.",
  semantic_uncertainty: "Confirm that the proposed sign preserves the intended meaning.",
  semantic_substitution: "Use a sign with the same meaning or the full English caption.",
  invalid_plan: "Repair the translator output before playback.",
  no_signs: "Use the full English caption until signs are available.",
};

/** Decide whether a translator plan may be played as a complete message. Never mutates the plan. */
export function assessSigning(originalText, plan, clips) {
  if (typeof originalText !== "string") throw new TypeError("originalText must be a string");
  const reasons = [];
  const add = (code, tokens = [], extra = {}) => {
    if (!reasons.some((r) => r.code === code && JSON.stringify(r.tokens) === JSON.stringify(tokens)))
      reasons.push({ code, tokens, next_action: actions[code], ...extra });
  };
  const normalized = originalText.trim().replace(/\s+/g, " ");
  if (!plan || typeof plan !== "object" || plan.input_text !== normalized || plan.caption !== normalized) {
    add("invalid_plan");
  } else if (plan.ok) {
    try { assertPlan(plan); } catch (error) { add("invalid_plan", [], { detail: error.message }); }
  } else if (!Array.isArray(plan.items) || plan.items.length || !Array.isArray(plan.unsupported_tokens)) {
    add("invalid_plan");
  }
  if (reasons.some((r) => r.code === "invalid_plan")) return decision("caption_only", originalText, reasons);

  const items = plan.items;
  const tokens = tokenize(normalized);
  const tokenWords = tokens.map((t) => t.w);
  const displayWords = normalized.split(" ");
  const unsupported = plan.unsupported_tokens ?? [];
  for (const token of unsupported) add("unsupported_token", [token]);
  if (!items.length) add("no_signs");

  // The translator may drop functional words. A dropped deictic or quantity is not safe by default.
  for (const token of plan.dropped_tokens ?? []) {
    if (HIGH_RISK_DROPS.has(String(token).toLowerCase())) {
      // In this fixed phrase, WHERE HURT carries the location question; it remains approximate ASL.
      if (String(token).toLowerCase() === "it" && /^where does it hurt\??$/i.test(normalized)) continue;
      add("dropped_meaning", [token]);
    }
  }

  // Check the original, not only the plan: contraction handling can hide a negator in a drop.
  const negators = tokens.filter((t) => NEGATIONS.has(t.w));
  if (negators.length && !items.some((i) => i.type === "sign" && NEGATING_GLOSSES.has(glossKey(i.gloss)))) {
    add("unrepresented_negation", [...new Set(negators.map((t) => t.raw))]);
  }
  if (/\b(?:no|not|never|without)\b/i.test(normalized) && !negators.length &&
      !items.some((i) => i.type === "sign" && NEGATING_GLOSSES.has(glossKey(i.gloss)))) add("unrepresented_negation");

  const numeric = tokens.filter((t) => /\d/.test(t.raw) || NUMBER_WORDS.has(t.w));
  if (numeric.length) add("numerical_meaning", [...new Set(numeric.map((t) => t.raw))]);

  for (const [itemIndex, item] of items.entries()) {
    if (!item || typeof item.source !== "string" || !item.source.trim() || !Number.isInteger(item.source_index) || item.source_index < 0 ||
        item.source_index >= displayWords.length || !item.match || typeof item.match.method !== "string" ||
        tokenize(item.source)[0]?.w !== tokenize(displayWords[item.source_index])[0]?.w ||
        (item.type === "sign" && !SIGN_METHODS.has(item.match.method)) ||
        (item.type === "fingerspell" && item.match.method !== "fingerspell")) {
      add("invalid_plan", [], { item_index: itemIndex });
      continue;
    }
    if (item.type === "sign") {
      const clip = clips?.signs?.get(item.motion_id);
      if (!clip || clip.gloss !== item.gloss) add("missing_clip", [item.source], { item_index: itemIndex, motion_id: item.motion_id });
      if (item.match.method === "semantic") {
        if (!Number.isFinite(item.match.score) || item.match.score < 0 || item.match.score > 1) {
          add("invalid_plan", [item.source], { item_index: itemIndex });
        } else if (item.source.toLowerCase() === "spouse" && GENDERED.has(glossKey(item.gloss))) {
          add("semantic_substitution", [item.source], { item_index: itemIndex, proposed_gloss: item.gloss });
        } else {
          add("semantic_uncertainty", [item.source], { item_index: itemIndex, proposed_gloss: item.gloss, score: item.match.score });
        }
      }
    } else if (item.type === "fingerspell") {
      const missing = [...item.word].filter((letter) => !clips?.letters?.get(letter));
      if (missing.length) add("missing_fingerspelling", [item.source], { item_index: itemIndex, missing_letters: [...new Set(missing)] });
    }
  }
  // The current clip manifest has no sense metadata. These surface words need a human choice.
  for (const word of tokenWords.filter((w) => HOMOGRAPHS.has(w))) add("ambiguous_sense", [word]);
  const status = reasons.some((r) => r.code !== "ambiguous_sense" && r.code !== "semantic_uncertainty")
    ? "caption_only" : reasons.length ? "needs_confirmation" : "fully_supported";
  return decision(status, originalText, reasons);
}

function decision(status, caption, reasons) {
  return { status, caption, reasons, next_actions: [...new Set(reasons.map((r) => r.next_action))] };
}
