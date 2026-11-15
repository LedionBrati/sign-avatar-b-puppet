// A live session: every final phrase (spoken or typed) becomes one /api/sign call; the responses are
// merged into a single running SignResponse so captionFrame() can drive the captions for the whole
// conversation, and the playlist just keeps growing at the end.
import type { SignResponse } from "@signlayer/core";

export const emptySession = (): SignResponse => ({
  text: "", words: [], playlist: [], unsupported: [], fingerspell: [], markers: [], plan: null, timings: { translate_ms: 0, total_ms: 0 },
});

export const norm = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");

export function appendResponse(s: SignResponse, r: SignResponse): SignResponse {
  const off = s.words.length, poff = s.playlist.length;
  return {
    text: s.text ? `${s.text} ${r.text}` : r.text,
    safety: r.safety,
    words: [...s.words, ...r.words],
    playlist: [...s.playlist, ...r.playlist.map((p) => ({ ...p, word_index: p.word_index >= 0 ? p.word_index + off : -1 }))],
    unsupported: [...s.unsupported, ...r.unsupported],
    fingerspell: [...s.fingerspell, ...r.fingerspell],
    markers: [...s.markers, ...r.markers.map((m) => ({ ...m, from: m.from + poff, to: m.to + poff }))],
    plan: r.plan,
    ...(r.generating?.length ? { generating: r.generating } : {}),
    timings: { translate_ms: s.timings.translate_ms + r.timings.translate_ms, total_ms: s.timings.total_ms + r.timings.total_ms },
  };
}

/** Word indices that could not be signed: in `unsupported`/`fingerspell` and not covered by any clip. Never shown as signed. */
export function unsignedWords(s: SignResponse): Set<number> {
  const covered = new Set(s.playlist.map((p) => p.word_index));
  const missing = new Set([...s.unsupported, ...s.fingerspell].map(norm));
  const out = new Set<number>();
  s.words.forEach((w, i) => { if (!covered.has(i) && missing.has(norm(w))) out.add(i); });
  return out;
}
