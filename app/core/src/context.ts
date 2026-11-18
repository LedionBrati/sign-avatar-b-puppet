// Sign -> voice without a model call: pick, per sign, which of the recognizer's top guesses to use so the whole run
// makes the most sense, with an optional tiny language-model prior (an add-k bigram over sign labels, bigram()).
// Without a prior every sign keeps its most confident guess. Mirror of app/recognizer/context.py (same numbers;
// a shared fixture test keeps the picks equal).
//
// score(combination) = sum_i log(confidence_i) + LM_WEIGHT * sum_i log P(label_i | label_{i-1})   (with <s> and </s>)
// Exact over the top TOP_K guesses per sign (Viterbi). A guess the signer fixed from the chips is the only option.
// The server's sentence model (/api/compose) does the same with real English knowledge; this is the offline fallback,
// and what the recognizer evals use to simulate compose (app/recognizer/eval/eval_generic.py).

export const CONTEXT = { topK: 3, lmWeight: 0.5, addK: 0.5 } as const;

const BOS = "<s>", EOS = "</s>";

export interface Bigram { logp(prev: string, next: string): number }

/** Add-k bigram over the sentences' labels (+ </s>). Unknown labels share the unseen mass like any unseen pair. */
export function bigram(sentences: readonly string[], k: number = CONTEXT.addK): Bigram {
  const pair = new Map<string, number>();
  const ctx = new Map<string, number>();
  const vocab = new Set<string>([EOS]);
  for (const s of sentences) {
    const w = [BOS, ...s.split(" ").filter(Boolean), EOS];
    for (let i = 1; i < w.length; i++) {
      vocab.add(w[i]!);
      pair.set(`${w[i - 1]} ${w[i]}`, (pair.get(`${w[i - 1]} ${w[i]}`) ?? 0) + 1);
      ctx.set(w[i - 1]!, (ctx.get(w[i - 1]!) ?? 0) + 1);
    }
  }
  const v = vocab.size;
  return { logp: (prev, next) => Math.log(((pair.get(`${prev} ${next}`) ?? 0) + k) / ((ctx.get(prev) ?? 0) + k * v)) };
}

/** No prior: every transition equally likely, so only the confidences count. */
const UNIFORM: Bigram = { logp: () => 0 };

export interface PickSign { options: { label: string; confidence: number }[]; fixed?: boolean; sel?: number }

/** Per sign, the index of the guess to use (Viterbi over the top topK guesses). Empty options -> -1. */
export function contextPick(signs: readonly PickSign[], o: { lm?: Bigram; lmWeight?: number; topK?: number } = {}): number[] {
  const lm = o.lm ?? UNIFORM, wt = o.lmWeight ?? CONTEXT.lmWeight, k = o.topK ?? CONTEXT.topK;
  const cand = signs.map((s) => {
    if (s.fixed) { const i = s.sel ?? 0; return s.options[i] ? [i] : []; }
    return s.options.slice(0, k).map((_, i) => i);
  });
  // best[j] = [score, back] for the current position's candidate j
  let prev: { label: string; score: number; back: number[] }[] = [{ label: BOS, score: 0, back: [] }];
  signs.forEach((s, p) => {
    if (!cand[p]!.length) { prev = prev.map((q) => ({ ...q, back: [...q.back, -1] })); return; }
    prev = cand[p]!.map((i) => {
      const opt = s.options[i]!;
      const emit = Math.log(Math.max(opt.confidence, 1e-4));
      let best = prev[0]!, bs = -Infinity;
      for (const q of prev) {
        const sc = q.score + wt * lm.logp(q.label, opt.label);
        if (sc > bs) { bs = sc; best = q; }
      }
      return { label: opt.label, score: bs + emit, back: [...best.back, i] };
    });
  });
  let end = prev[0]!, es = -Infinity;
  for (const q of prev) {
    const sc = q.score + wt * lm.logp(q.label, EOS);
    if (sc > es) { es = sc; end = q; }
  }
  return end.back;
}

/** The labels contextPick chooses (signs without options are left out). */
export function contextLabels(signs: readonly PickSign[], o?: Parameters<typeof contextPick>[1]): string[] {
  return contextPick(signs, o).flatMap((i, p) => (i >= 0 ? [signs[p]!.options[i]!.label] : []));
}
