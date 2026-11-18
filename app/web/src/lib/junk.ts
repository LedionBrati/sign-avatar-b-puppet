// Junk filter for the open vocabulary (all 250+ GISLR signs): toddler-vocabulary labels (DOWNWEIGHT) are removed from
// the recognizer's guesses unless they are the only plausible guess at >= JUNK_KEEP_CONF.
import type { RecognizeResponse } from "@flux/core";

type Option = RecognizeResponse["options"][number];

/** Toddler-vocabulary GISLR labels that the recognizer over-predicts on adult conversation: dropped unless they are
 *  the only plausible guess. (potty is not here: the sentence model reads it as "bathroom".) */
export const DOWNWEIGHT: readonly string[] = [
  "alligator", "animal", "balloon", "bee", "bird", "carrot", "cat", "chocolate", "clown", "cow", "cowboy", "donkey", "doll",
  "duck", "elephant", "fireman", "frenchfries", "frog", "giraffe", "goose", "gum", "hen", "horse", "kitty", "lion", "mitten",
  "owl", "owie", "penny", "pig", "puppy", "puzzle", "snack", "tiger", "vacuum", "wolf", "zebra", "zipper", "underwear",
];
const JUNK = new Set(DOWNWEIGHT.map((l) => l.toLowerCase()));
export const isJunk = (label: string) => JUNK.has(label.toLowerCase());

const JUNK_KEEP_CONF = 0.7; // a DOWNWEIGHT label survives only at this confidence...
const PLAUSIBLE = 0.1; // ...and no other (non-junk) guess at or above this

/** Sorted guesses without junk labels, unless the junk label is the only plausible guess with high confidence. */
export function dejunk(options: Option[]): Option[] {
  const sorted = [...options].sort((a, b) => b.confidence - a.confidence);
  const top = sorted[0];
  if (top && isJunk(top.label) && top.confidence >= JUNK_KEEP_CONF
    && !sorted.some((o) => !isJunk(o.label) && o.confidence >= PLAUSIBLE)) return sorted;
  return sorted.filter((o) => !isJunk(o.label));
}
