// The signs of the sentence being built, and their local wording (no model).
import { composeSentence, knownPhrase, labelText, type RecognizeResponse } from "@flux/core";

export type Option = RecognizeResponse["options"][number];
/** One recognized sign. fixed: the signer picked this guess from the chips, so the model gets it as certain. */
export interface Entry { label: string; options?: Option[]; sel?: number; fixed?: boolean }

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** potty is read by its bathroom meaning (the server's sentence model does the same). */
const localLabel = (l: string) => (l.toLowerCase() === "potty" ? "bathroom" : l);
/** "#NAME" is a fingerspelled word. */
export const wordOf = (l: string) => (l.startsWith("#") ? cap(l.slice(1).toLowerCase()) : labelText(localLabel(l)));
export const localSentence = (xs: Entry[]) => composeSentence(xs.map((x) => localLabel(x.label)));
export const fixedSentence = (xs: Entry[]) => knownPhrase(xs.map((x) => localLabel(x.label)));
/** These exact signs in this sentence (epoch): the model's answer only counts for the key it was asked with. */
export const keyOf = (epoch: number, xs: Entry[]) => `${epoch}|${xs.map((x) => x.label).join(" ")}`;
