// Local semantic matching: nearest vocab gloss by cosine similarity of sentence embeddings.
// Runs a small quantized model with transformers.js in Node or the browser. No API calls:
// the model files are downloaded once from the Hugging Face hub and cached; after that it works offline.
// Plain ESM; Node-specific caching (files on disk) is injected via `store` and `cacheDir` (see node.mjs).

export const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
// Calibrated on word pairs in experiments/2026-11-15-translate-no-llm.md:
// true near-synonyms mostly score >= 0.70; unrelated or loosely related words mostly < 0.65.
export const DEFAULT_THRESHOLD = 0.7;

/** Small, sync, browser-safe string hash (FNV-1a 32 bit, hex). */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** In-memory embedding store (default; the Node helper swaps in a disk store). */
export function memoryStore() {
  const m = new Map();
  return { async get(key) { return m.get(key) ?? null; }, async set(key, value) { m.set(key, value); } };
}

export class SemanticMatcher {
  /**
   * @param {object} o
   * @param {string} [o.model]      transformers.js model id
   * @param {string} [o.dtype]      "q8" = quantized (~23 MB download for MiniLM)
   * @param {number} [o.threshold]  minimum cosine similarity to accept a match
   * @param {object} [o.store]      {get(key), set(key, {dim, keys, data: Float32Array})}
   * @param {string} [o.cacheDir]   where transformers.js keeps model files (Node)
   * @param {boolean} [o.allowRemote] false = never touch the network (cache only)
   * @param {Function} [o.importer] override for `import("@huggingface/transformers")` (tests)
   */
  constructor(o = {}) {
    this.model = o.model ?? DEFAULT_MODEL;
    this.dtype = o.dtype ?? "q8";
    this.threshold = o.threshold ?? DEFAULT_THRESHOLD;
    this.store = o.store ?? memoryStore();
    this.cacheDir = o.cacheDir;
    this.allowRemote = o.allowRemote ?? true;
    this.importer = o.importer ?? (() => import("@huggingface/transformers"));
    this.extractor = null;
    this.loading = null;
    this.failed = null;
    this.vocabCache = new Map();
    this.stats = { model_load_ms: 0, vocab_embed_ms: 0, vocab_cache: null };
  }

  /** Load the model once. Resolves to true, or false (with this.failed set) if it cannot load. */
  async load() {
    if (this.extractor) return true;
    if (this.failed) return false;
    if (!this.loading) {
      this.loading = (async () => {
        const t0 = performance.now();
        try {
          const t = await this.importer();
          if (this.cacheDir) t.env.cacheDir = this.cacheDir;
          t.env.allowRemoteModels = this.allowRemote;
          this.extractor = await t.pipeline("feature-extraction", this.model, { dtype: this.dtype });
          return true;
        } catch (error) {
          this.failed = error instanceof Error ? error.message : String(error);
          return false;
        } finally {
          this.stats.model_load_ms = Math.round(performance.now() - t0);
        }
      })();
    }
    return this.loading;
  }

  /** Mean-pooled, L2-normalized embeddings as one flat Float32Array (n * dim). */
  async embed(texts) {
    const out = [];
    let dim = 0;
    for (let i = 0; i < texts.length; i += 64) {
      const t = await this.extractor(texts.slice(i, i + 64), { pooling: "mean", normalize: true });
      dim = t.dims[t.dims.length - 1];
      out.push(t.data);
    }
    const data = new Float32Array(texts.length * dim);
    let off = 0;
    for (const chunk of out) { data.set(chunk, off); off += chunk.length; }
    return { dim, data };
  }

  /** Embeddings for the vocab keys, computed once per (model, vocab) and cached in the store. */
  async vocabEmbeddings(keys) {
    const cacheKey = `${this.model.replace(/[^A-Za-z0-9]+/g, "_")}-${this.dtype}-${hashString(keys.join("\n"))}`;
    if (this.vocabCache.has(cacheKey)) { this.stats.vocab_cache = "memory"; return this.vocabCache.get(cacheKey); }
    const t0 = performance.now();
    let entry = await this.store.get(cacheKey);
    if (entry && entry.keys?.length === keys.length && entry.keys.every((k, i) => k === keys[i])) {
      this.stats.vocab_cache = "store";
    } else {
      const { dim, data } = await this.embed(keys);
      entry = { dim, keys, data };
      await this.store.set(cacheKey, entry);
      this.stats.vocab_cache = "computed";
    }
    this.stats.vocab_embed_ms = Math.round(performance.now() - t0);
    this.vocabCache.set(cacheKey, entry);
    return entry;
  }

  /**
   * For each query word, the nearest vocab key and its cosine similarity (top 3 kept for the trace).
   * @returns {Promise<Array<{query, key, score, alternatives}>>}
   */
  async nearest(queries, keys) {
    if (!queries.length || !keys.length) return [];
    const vocab = await this.vocabEmbeddings(keys);
    const q = await this.embed(queries);
    const { dim } = vocab;
    return queries.map((query, qi) => {
      const top = [];
      for (let k = 0; k < keys.length; k++) {
        let s = 0;
        for (let d = 0; d < dim; d++) s += q.data[qi * dim + d] * vocab.data[k * dim + d];
        if (top.length < 3 || s > top[top.length - 1].score) {
          top.push({ key: keys[k], score: s });
          top.sort((a, b) => b.score - a.score);
          if (top.length > 3) top.pop();
        }
      }
      const round = (x) => Math.round(x * 1000) / 1000;
      return { query, key: top[0].key, score: round(top[0].score),
        alternatives: top.slice(1).map((t) => ({ key: t.key, score: round(t.score) })) };
    });
  }
}
