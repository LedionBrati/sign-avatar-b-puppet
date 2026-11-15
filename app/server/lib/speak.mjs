// Text -> natural speech for sign -> voice (the browser's speechSynthesis voice is robotic), via OpenAI text-to-speech.
//
//   POST /api/speak  {text, voice?}  ->  audio/mpeg (mp3)
//
// Text (<= 400 chars) is sent to OpenAI and never logged or stored; a small LRU keeps recent audio so a repeated
// sentence ("Thank you!") costs nothing. SPEAK=off disables; SPEAK_MODEL / SPEAK_VOICE override the defaults.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { redactor } from "./secrets.mjs";

export const SPEAK_ROUTE = "/api/speak";
export const DEFAULT_SPEAK_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_SPEAK_VOICE = "coral";
export const MAX_SPEAK_CHARS = 400;
export const SPEAK_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"]);
const CACHE_ITEMS = 40;
const STYLE = "Speak as a warm, friendly person in a normal conversation: natural pace, relaxed, clear. Not like an announcer.";

/**
 * @param {object} o
 * @param {{audio: {speech: {create: Function}}}} o.client  OpenAI client (or a fake with that shape, for tests)
 * @param {string} [o.model]      SPEAK_MODEL env or DEFAULT_SPEAK_MODEL
 * @param {string} [o.voice]      SPEAK_VOICE env or DEFAULT_SPEAK_VOICE
 * @param {number} [o.timeoutMs]  default 8000
 * @param {string[]} [o.secrets]  redacted from every error message
 */
export function createSpeaker(o) {
  if (!o?.client?.audio?.speech?.create) throw new TypeError("createSpeaker needs an OpenAI client");
  const model = o.model ?? process.env.SPEAK_MODEL ?? DEFAULT_SPEAK_MODEL;
  const envVoice = o.voice ?? process.env.SPEAK_VOICE;
  const voice = envVoice && SPEAK_VOICES.has(envVoice) ? envVoice : DEFAULT_SPEAK_VOICE;
  const timeoutMs = o.timeoutMs ?? 8000;
  const redact = redactor(...(o.secrets ?? []));
  const cache = new Map();

  /** @returns {Promise<{audio: Buffer, cached: boolean, latency_ms: number}>} throws {code, message} (message redacted, never the text) */
  async function speak(text, { voice: v } = {}) {
    const t0 = performance.now();
    const use = v && SPEAK_VOICES.has(v) ? v : voice;
    const key = createHash("sha256").update(`${model}\n${use}\n${text}`).digest("hex");
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return { audio: hit, cached: true, latency_ms: 0 }; }
    let audio;
    try {
      const res = await o.client.audio.speech.create(
        { model, voice: use, input: text, response_format: "mp3", ...(/tts-1/.test(model) ? {} : { instructions: STYLE }) },
        { signal: AbortSignal.timeout(timeoutMs), timeout: timeoutMs, maxRetries: 0 });
      audio = Buffer.from(await res.arrayBuffer());
    } catch (error) {
      const code = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : error?.status === 429 ? "rate_limited" : "upstream";
      throw Object.assign(new Error(redact(error)), { code });
    }
    if (!audio.length) throw Object.assign(new Error("empty audio"), { code: "upstream" });
    if (cache.size >= CACHE_ITEMS) cache.delete(cache.keys().next().value);
    cache.set(key, audio);
    return { audio, cached: false, latency_ms: Math.round(performance.now() - t0) };
  }
  return { model, voice, timeoutMs, speak };
}

/** Validate {text, voice?}. Throws {status, code, message}. */
export function parseSpeak(body) {
  const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
  if (!body || typeof body !== "object" || typeof body.text !== "string") throw fail(400, "bad_request", "body must be {text, voice?}");
  const text = body.text.replace(/\s+/g, " ").trim();
  if (!text) throw fail(400, "bad_request", "text is empty");
  if (text.length > MAX_SPEAK_CHARS) throw fail(413, "text_too_long", `text over ${MAX_SPEAK_CHARS} characters`);
  if (body.voice !== undefined && !SPEAK_VOICES.has(body.voice)) throw fail(400, "bad_voice", `voice must be one of ${[...SPEAK_VOICES].join(", ")}`);
  return { text, voice: body.voice };
}

/** Speaker from the environment (same key as transcribe/compose), or null. Never under node --test unless AGENT_IN_TESTS=1. */
export function speakerFromEnv(keyInfo, log = () => {}) {
  if (process.env.SPEAK === "off" || process.env.SPEAK === "0") return null;
  if (process.env.NODE_TEST_CONTEXT && process.env.AGENT_IN_TESTS !== "1") return null;
  if (!keyInfo?.key) return null;
  let OpenAI;
  try { OpenAI = createRequire(import.meta.url)("openai").OpenAI; } catch {
    log("speak off: the openai package is not installed (cd app/server && npm i)");
    return null;
  }
  const s = createSpeaker({ client: new OpenAI({ apiKey: keyInfo.key, maxRetries: 0 }), secrets: [keyInfo.key] });
  log(`speak: ${s.model} (${s.voice})`);
  return s;
}
