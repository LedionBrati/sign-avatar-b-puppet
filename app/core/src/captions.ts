// Caption word states, as in the Flux prototype:
//   upcoming (hidden) -> heard (visible) -> signed (solid) ; "now" = the word being signed (tinted highlight).
// Pure logic, no DOM, shared by web, extension and mobile.

import type { SignResponse } from "./api.ts";

export type WordState = "upcoming" | "heard" | "signed" | "now";

export interface CaptionFrame {
  states: WordState[];
  /** Index of the playlist item being signed, -1 before/after. */
  current: number;
  /** "Signing THANK YOU for “thank”" or "Listening…" / "" when done. */
  nowLine: string;
}

/**
 * @param res        the /api/sign response
 * @param heardCount how many words have been heard so far (live speech), or words.length for typed text
 * @param playing    index of the playlist item currently playing (-1 = not started, playlist.length = finished)
 */
/** Chip text for signs being generated on demand: "Generating SICK… ~2 min" ("" when nothing is generating). */
export function generatingLabel(res: Pick<SignResponse, "generating"> | null | undefined): string {
  const g = res?.generating ?? [];
  if (!g.length) return "";
  const names = g.length <= 2 ? g.map((x) => x.gloss).join(", ") : `${g[0]!.gloss} +${g.length - 1}`;
  const eta = Math.max(...g.map((x) => x.eta_s));
  const when = eta < 60 ? "<1 min" : `~${Math.round(eta / 60)} min`;
  return `Generating ${names}… ${when}`;
}

export function captionFrame(res: SignResponse, heardCount: number, playing: number): CaptionFrame {
  const n = res.words.length;
  const done = playing >= res.playlist.length && res.playlist.length > 0;
  const signedWords = new Set<number>();
  res.playlist.forEach((p, i) => {
    if (p.word_index >= 0 && (i < playing || done)) signedWords.add(p.word_index);
  });
  const cur = !done && playing >= 0 ? res.playlist[playing] : undefined;
  const states: WordState[] = Array.from({ length: n }, (_, i) => {
    if (cur && cur.word_index === i) return "now";
    if (signedWords.has(i) || done) return "signed";
    if (i < heardCount) return "heard";
    return "upcoming";
  });
  const word = cur && cur.word_index >= 0 ? res.words[cur.word_index]?.replace(/[.,:;!?]+$/, "") : undefined;
  const nowLine = cur ? `Signing ${cur.gloss}${word ? ` for “${word}”` : ""}` : done ? "" : "Listening…";
  return { states, current: cur ? playing : -1, nowLine };
}

/** Total signing time of a playlist, seconds. */
export const playlistSeconds = (res: Pick<SignResponse, "playlist">) => res.playlist.reduce((s, p) => s + p.duration_s, 0);
