// Node-only helpers: vocab loaders, disk cache for embeddings and model files, English word list.
// The browser uses index.mjs directly and passes its own vocab / matcher.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SemanticMatcher } from "./semantic.mjs";
import { toMotionId } from "./rules.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..");
export const CACHE_DIR = join(HERE, "cache");

const firstExisting = (paths) => paths.find((p) => p && existsSync(p));

/** Default clip set: $SIGN_CLIPS_DIR, <repo>/out/realtime/clips, or the main checkout next to this worktree. */
export function defaultClipsDir() {
  return firstExisting([
    process.env.SIGN_CLIPS_DIR,
    join(REPO, "out", "realtime", "clips"),
    join(REPO, "..", "sign-avatar-b-puppet", "out", "realtime", "clips"),
  ]);
}

/** Full WLASL-derived dictionary index: $SIGN_DICTIONARY or ../ai-summit/data/signs/index.json. */
export function defaultDictionaryPath() {
  return firstExisting([
    process.env.SIGN_DICTIONARY,
    join(REPO, "..", "ai-summit", "data", "signs", "index.json"),
  ]);
}

const isLetterClip = (id, entry) => /^FS_[A-Z]$/.test(id) || (typeof entry?.letter === "string" && /^[A-Z]$/.test(entry.letter));

/** Clips manifest {MOTION_ID: {gloss, file, ...}} -> vocab. Fingerspelling letter clips are not vocab. */
export function vocabFromManifest(manifest) {
  return Object.entries(manifest).filter(([id, e]) => !isLetterClip(id, e) && e?.gloss)
    .map(([motion_id, e]) => ({ motion_id, gloss: e.gloss }));
}

/** Any of: an array of {motion_id, gloss}; a clips manifest; or a dictionary {"thank you": {...}}. */
export function vocabFromJson(json) {
  if (Array.isArray(json)) return json.filter((v) => v?.motion_id && v?.gloss);
  const values = Object.values(json);
  if (values.length && values.every((v) => v && typeof v === "object" && typeof v.gloss === "string")) return vocabFromManifest(json);
  // Dictionary keys are lowercase English glosses; motion_id convention as in sign-clips.mjs.
  return Object.keys(json).map((gloss) => ({ motion_id: toMotionId(gloss), gloss: gloss.toUpperCase() }))
    .filter((v) => /^[A-Z]/.test(v.motion_id));
}

/** spec: "clips" | "dictionary" | path to a clips dir, manifest.json, dictionary index.json or vocab array. */
export function loadVocab(spec = "clips") {
  let path = spec;
  if (spec === "clips") path = defaultClipsDir();
  else if (spec === "dictionary") path = defaultDictionaryPath();
  if (!path || !existsSync(path)) throw new Error(`vocab not found for "${spec}" (set SIGN_CLIPS_DIR / SIGN_DICTIONARY or pass a path)`);
  if (statSync(path).isDirectory()) path = join(path, "manifest.json");
  const vocab = vocabFromJson(JSON.parse(readFileSync(path, "utf8")));
  return Object.assign(vocab, { source: path });
}

let words = null;
/** ~275k lowercase English words (an-array-of-english-words, MIT). Used only to spot names/non-words. */
export function loadEnglishWords() {
  if (!words) words = new Set(createRequire(import.meta.url)("an-array-of-english-words"));
  return words;
}

/** Disk store for vocab embeddings: translate/cache/<key>.json + .bin (gitignored). */
export function diskStore(dir = CACHE_DIR) {
  return {
    async get(key) {
      const meta = join(dir, `${key}.json`), bin = join(dir, `${key}.bin`);
      if (!existsSync(meta) || !existsSync(bin)) return null;
      const { dim, keys } = JSON.parse(readFileSync(meta, "utf8"));
      const buf = readFileSync(bin);
      return { dim, keys, data: new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) };
    },
    async set(key, { dim, keys, data }) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${key}.bin`), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      writeFileSync(join(dir, `${key}.json`), JSON.stringify({ dim, keys }));
    },
  };
}

/** Matcher with model files in translate/cache/models and vocab embeddings on disk. */
export function createNodeMatcher(options = {}) {
  return new SemanticMatcher({ cacheDir: join(CACHE_DIR, "models"), store: diskStore(), ...options });
}
