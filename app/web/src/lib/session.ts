// Turns the phrases of a live session + the player's position into caption words, the now-line and the summary.
// Pure logic on top of captionFrame() from @signlayer/core.
import { captionFrame, type SignResponse, type WordState } from "@signlayer/core";

export interface Phrase {
  id: number;
  text: string;
  /** null while /api/sign is in flight. */
  res: SignResponse | null;
  /** Index of this phrase's first clip in the session playlist (set when appended to the player). */
  offset: number;
  error?: string;
}

export type WordClass = WordState | "interim";
export interface CapWord { text: string; state: WordClass; nosign?: "unsupported" | "fingerspell" }

export const norm = (w: string) => w.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}']/gu, "");
export const splitWords = (t: string) => t.trim().split(/\s+/).filter(Boolean);

export interface SessionView {
  words: CapWord[];
  /** Index into `words` of the word being signed, -1 if none. */
  now: number;
  nowGloss: string;
  nowWord: string;
  unsupported: string[];
  fingerspell: string[];
}

/** @param playing global playlist index from the player (-1 before start, total length when drained) */
export function sessionView(phrases: Phrase[], playing: number, interim: string): SessionView {
  const words: CapWord[] = [];
  let now = -1, nowGloss = "", nowWord = "";
  const unsupported: string[] = [], fingerspell: string[] = [];
  for (const p of phrases) {
    if (!p.res) { splitWords(p.text).forEach((text) => words.push({ text, state: "heard" })); continue; }
    const r = p.res, len = r.playlist.length;
    const local = len === 0 ? -1 : playing < p.offset ? -1 : Math.min(playing - p.offset, len);
    const f = captionFrame(r, r.words.length, local);
    const uns = new Set(r.unsupported.map(norm)), fs = new Set(r.fingerspell.map(norm));
    const covered = new Set(r.playlist.map((x) => x.word_index));
    r.unsupported.forEach((w) => unsupported.push(w));
    r.fingerspell.forEach((w) => fingerspell.push(w));
    // Words with no sign of their own ("you," in "thank you,") go solid once signing has passed them, as in the prototype.
    let reached = -1;
    f.states.forEach((st, i) => { if (st === "signed" || st === "now") reached = i; });
    r.words.forEach((text, i) => {
      const n = norm(text);
      const nosign = covered.has(i) ? undefined : fs.has(n) ? "fingerspell" : uns.has(n) ? "unsupported" : undefined;
      let state = f.states[i] ?? "heard";
      if (state === "heard" && !covered.has(i) && !nosign && i < reached) state = "signed";
      if (state === "now") {
        now = words.length;
        const cur = r.playlist[f.current];
        nowGloss = cur?.gloss ?? "";
        nowWord = text.replace(/[.,:;!?"]+$/, "");
      }
      words.push({ text, state, nosign });
    });
    if (f.current >= 0 && now < 0) {
      // Signing a clip with no source word.
      nowGloss = r.playlist[f.current]?.gloss ?? "";
    }
  }
  splitWords(interim).forEach((text) => words.push({ text, state: "interim" }));
  return { words, now, nowGloss, nowWord, unsupported: [...new Set(unsupported)], fingerspell: [...new Set(fingerspell)] };
}
