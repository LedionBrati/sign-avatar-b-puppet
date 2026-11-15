// Sign -> voice: turn recognized sign labels into a short English sentence, with NO model call.
// Rough rules only (ASL is its own language): WH-question signs at the end move to the front and the
// sentence becomes a question; a few labels map to nicer English. The signer always sees and can edit
// the sentence before it is spoken.

/** GISLR (Kaggle "asl-signs") labels that are not plain English words. */
const LABEL_TEXT: Record<string, string> = {
  thankyou: "thank you",
  callonphone: "call on the phone",
  minemy: "my",
  hesheit: "they",
  weus: "we",
  haveto: "have to",
  glasswindow: "window",
  frenchfries: "french fries",
  icecream: "ice cream",
  owie: "hurt",
  shhh: "quiet",
  TV: "TV",
  yourself: "you",
};

const WH = new Set(["where", "what", "who", "why", "when", "how", "which"]);
/** Single signs that read as a verb after a WH-word ("HURT WHERE" -> "Where does it hurt?"). */
const VERB_LIKE = new Set(["hurt", "go", "stay", "hide", "fall", "taste", "look", "sleep", "wait", "read", "say", "think", "like", "work"]);

/** Display text for one recognizer label. */
export const labelText = (label: string) => LABEL_TEXT[label] ?? LABEL_TEXT[label.toLowerCase()] ?? label.toLowerCase().replace(/_/g, " ");

/**
 * @param labels recognized signs in signing order (e.g. ["hurt", "where"])
 * @param spelled optional fingerspelled words to insert where they were signed: use "#WORD" entries in labels
 */
export function composeSentence(labels: string[]): string {
  const words = labels.filter(Boolean).map((l) => (l.startsWith("#") ? cap(l.slice(1).toLowerCase()) : labelText(l)));
  if (words.length === 0) return "";
  let question = false;
  const last = words[words.length - 1]!.toLowerCase();
  if (WH.has(last) && words.length > 1) {
    // ASL puts the WH-sign last ("HURT WHERE"); English puts it first ("where ... hurt?").
    words.pop();
    // "HURT WHERE" -> "where does it hurt"; longer phrases just move the WH-word to the front.
    if (words.length === 1 && VERB_LIKE.has(words[0]!.toLowerCase())) words.unshift("does it");
    words.unshift(last);
    question = true;
  } else if (WH.has(words[0]!.toLowerCase())) {
    question = true;
  }
  let text = words.join(" ").replace(/\bi\b/g, "I");
  text = cap(text);
  return text + (question ? "?" : ".");
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
