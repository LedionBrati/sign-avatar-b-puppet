// Turning page captions into phrases worth signing. Pure logic (no DOM), unit-tested in test/phrases.test.ts.
//
//  - PhraseAssembler: fed the *visible* caption text over and over (YouTube's rolling auto-captions grow word by
//    word and scroll; pop-on captions replace whole lines). It works out which words are new, buffers them and
//    emits a phrase at a sentence end, on a pause, or when it gets long.
//  - cuesFromTranscript / cueAt: a timed transcript (YouTube's transcript panel, or <track> cues) split into
//    sentence-sized cues, looked up by video time.

export const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
const words = (t: string) => t.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
/** Non-speech annotations: [Music], (Laughter), ♪ … ♪ */
export const stripAnnotations = (t: string) =>
  t.replace(/\[[^\]]*\]|\([^)]*\)|♪[^♪]*♪|♪/g, " ").replace(/^\s*>>\s*/, "").replace(/\s+/g, " ").trim();

export interface AssemblerOptions {
  /** Flush when the captions have not changed for this long. */
  pauseMs: number;
  /** Flush at this many buffered words (at the last comma if there is one). */
  maxWords: number;
  /** Never hold the first buffered word longer than this. */
  maxHoldMs: number;
}

export class PhraseAssembler {
  private history: string[] = []; // normalized words already taken from the captions (last ~60)
  private pending: { w: string; t: number }[] = [];
  private lastChange = 0;
  private lastVisible = "";
  readonly o: AssemblerOptions;
  private emit: (text: string) => void;

  constructor(emit: (text: string) => void, o: Partial<AssemblerOptions> = {}) {
    this.emit = emit;
    this.o = { pauseMs: 750, maxWords: 14, maxHoldMs: 3500, ...o };
  }

  /** Words of `visible` that are new compared with what was already taken (rolling + growing captions). */
  private fresh(visible: string[]): string[] {
    const v = visible.map(norm);
    const h = this.history;
    // Largest k: the last k history words equal the first k visible words.
    for (let k = Math.min(h.length, v.length); k > 0; k--) {
      let ok = true;
      for (let i = 0; i < k; i++) if (h[h.length - k + i] !== v[i]) { ok = false; break; }
      if (ok) return visible.slice(k);
    }
    // The recogniser revised its last word ("government" -> "governments"): match with that word swapped.
    for (let k = Math.min(h.length, v.length); k > 1; k--) {
      let ok = true;
      for (let i = 0; i < k - 1; i++) if (h[h.length - k + i] !== v[i]) { ok = false; break; }
      if (ok && v[k - 1]!.startsWith(h[h.length - 1]!.slice(0, 3))) {
        // Fix the revised word if it has not been emitted yet.
        const last = this.pending.at(-1);
        if (last && norm(last.w) === h[h.length - 1]) { last.w = visible[k - 1]!; h[h.length - 1] = v[k - 1]!; }
        return visible.slice(k);
      }
    }
    // The whole visible text is somewhere in recent history (captions re-rendered / scrolled back).
    const joined = ` ${h.join(" ")} `;
    if (v.length && joined.includes(` ${v.join(" ")} `)) return [];
    return visible;
  }

  update(visibleText: string, now = Date.now()) {
    const text = stripAnnotations(visibleText);
    if (text === this.lastVisible) return;
    this.lastVisible = text;
    const vis = words(text);
    if (!vis.length) return;
    const add = this.fresh(vis);
    if (!add.length) return;
    this.lastChange = now;
    for (const w of add) {
      this.pending.push({ w, t: now });
      this.history.push(norm(w));
    }
    if (this.history.length > 60) this.history.splice(0, this.history.length - 60);
    this.cut(now);
  }

  /** Call every ~150-250 ms: flushes on pauses and long holds. */
  tick(now = Date.now()) {
    if (!this.pending.length) return;
    if (now - this.lastChange >= this.o.pauseMs || now - this.pending[0]!.t >= this.o.maxHoldMs) this.flush(this.pending.length);
  }

  private cut(now: number) {
    // Sentence ends inside the buffer.
    for (;;) {
      const i = this.pending.findIndex((p, k) => k >= 1 && /[.?!]["')\]]*$/.test(p.w));
      if (i < 0) break;
      this.flush(i + 1);
    }
    if (this.pending.length >= this.o.maxWords) {
      let at = -1;
      for (let k = this.pending.length - 2; k >= 3; k--) if (/[,;:]$/.test(this.pending[k]!.w)) { at = k; break; }
      this.flush(at >= 0 ? at + 1 : this.pending.length);
    }
    void now;
  }

  flush(n = this.pending.length) {
    const take = this.pending.splice(0, n);
    const text = take.map((p) => p.w).join(" ").trim();
    if (text && /[\p{L}\p{N}]/u.test(text)) this.emit(text);
  }

  reset() {
    this.history = [];
    this.pending = [];
    this.lastVisible = "";
  }
}

export interface Cue { start: number; end: number; text: string }

/**
 * Raw transcript segments (start seconds + text, in order) -> sentence-sized cues.
 * Long segments are split at sentence ends, their time shared out by length; annotations are dropped.
 */
export function cuesFromTranscript(segs: { start: number; text: string }[], maxChars = 120): Cue[] {
  const out: Cue[] = [];
  segs.forEach((s, i) => {
    const end = segs[i + 1]?.start ?? s.start + Math.max(2, s.text.length / 14);
    const text = stripAnnotations(s.text);
    if (!text) return;
    const parts = splitSentences(text, maxChars);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let t = s.start;
    for (const p of parts) {
      const d = ((end - s.start) * p.length) / total;
      out.push({ start: round(t), end: round(t + d), text: p });
      t += d;
    }
  });
  return out;
}

function splitSentences(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.?!]+(?:[.?!]+["')\]]*|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxChars) { out.push(s); continue; }
    // Over-long sentence: split at commas, then at word boundaries.
    let cur = "";
    for (const piece of s.split(/(?<=[,;:])\s+/)) {
      if (cur && (cur + " " + piece).length > maxChars) { out.push(cur); cur = piece; } else cur = cur ? `${cur} ${piece}` : piece;
      while (cur.length > maxChars * 1.4) {
        const cutAt = cur.lastIndexOf(" ", maxChars);
        out.push(cur.slice(0, cutAt > 0 ? cutAt : maxChars));
        cur = cur.slice(cutAt > 0 ? cutAt + 1 : maxChars);
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Index of the cue playing at time t (last cue with start <= t), -1 before the first. Binary search. */
export function cueAt(cues: Cue[], t: number): number {
  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** "1:02:03" / "0:12" -> seconds. */
export function parseClock(s: string): number {
  const parts = s.trim().split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
