// Speech -> text for short audio chunks (the extension's "Tab audio" source), via OpenAI speech-to-text.
//
//   POST /api/transcribe   body: raw audio (audio/webm opus from MediaRecorder; also ogg, wav, mpeg, mp4)
//                          ?lang=en (ISO-639-1, optional)  ?prev=<last words, for continuity across chunks (optional)>
//                          X-Audio-Ms: chunk length in ms (optional; rejected over MAX_AUDIO_MS)
//                          -> { text, model, timings: { transcribe_ms, total_ms } }
//
// Audio is sent to OpenAI and never stored or logged. The API key is never logged or returned (lib/secrets.mjs).

import { createRequire } from "node:module";
import { redactor } from "./secrets.mjs";

export const TRANSCRIBE_ROUTE = "/api/transcribe";
/**
 * Picked 2026-11-15 from the key's model list (scripts/transcribe-bench.mjs on 5 real 2-5 s tab-audio chunks of a TED talk):
 * median round trip gpt-transcribe 513 ms, gpt-4o-mini-transcribe 560 ms, gpt-4o-transcribe 606 ms, whisper-1 1007 ms.
 * mini-transcribe: the same text on these chunks, within 50 ms of the fastest, and the cheapest per minute.
 * Clients should not send ?prev= for overlapping chunks: on a mostly-silent tail the models echo the prompt.
 */
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 10_000;
/** 2 MB: ~60 s of opus at the extension's bitrate; real chunks are 3-5 s (~30-60 kB). */
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_AUDIO_MS = 30_000;
const MIN_AUDIO_BYTES = 512;
const TYPES = { "audio/webm": "webm", "video/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "mp4", "audio/m4a": "m4a", "audio/x-m4a": "m4a" };
/** Whisper-family hallucinations on silence / music; never worth signing. */
const NOISE = /^(?:\s*(?:\[[^\]]*\]|\([^)]*\)|♪+|thank you\.?|thanks for watching[.!]?|you|bye\.?|\.+)\s*)*$/i;

/**
 * @param {object} o
 * @param {{audio: {transcriptions: {create: Function}}}} o.client   OpenAI client (or a fake with that shape, for tests)
 * @param {string} [o.model]       default TRANSCRIBE_MODEL env or DEFAULT_TRANSCRIBE_MODEL
 * @param {number} [o.timeoutMs]   per request
 * @param {string[]} [o.secrets]   redacted from every error message
 */
export function createTranscriber(o) {
  if (!o?.client?.audio?.transcriptions?.create) throw new TypeError("createTranscriber needs an OpenAI client");
  const model = o.model ?? process.env.TRANSCRIBE_MODEL ?? DEFAULT_TRANSCRIBE_MODEL;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS;
  const redact = redactor(...(o.secrets ?? []));
  const stats = { requests: 0, failures: 0, bytes: 0 };

  /** @returns {Promise<{ok: true, text: string, model: string, latency_ms: number} | {ok: false, code: string, error: string, model: string, latency_ms: number}>} */
  async function transcribe(audio, { mime = "audio/webm", language, prompt } = {}) {
    const t0 = performance.now();
    const ext = TYPES[mime] ?? "webm";
    stats.requests++;
    stats.bytes += audio.length;
    const params = { model, file: new File([audio], `chunk.${ext}`, { type: mime }), response_format: "json" };
    if (language) params.language = language;
    if (prompt) params.prompt = prompt;
    const ac = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs); });
    try {
      const r = await Promise.race([o.client.audio.transcriptions.create(params, { signal: ac.signal, timeout: timeoutMs, maxRetries: 0 }), timeout]);
      const raw = typeof r === "string" ? r : String(r?.text ?? "");
      const text = raw.replace(/\s+/g, " ").trim();
      return { ok: true, text: NOISE.test(text) ? "" : text, model, latency_ms: ms(performance.now() - t0) };
    } catch (error) {
      stats.failures++;
      const code = ac.signal.aborted ? "timeout" : error?.status === 400 ? "bad_audio" : error?.status === 429 ? "rate_limited" : "upstream";
      return { ok: false, code, error: redact(error), model, latency_ms: ms(performance.now() - t0) };
    } finally { clearTimeout(timer); }
  }
  return { model, timeoutMs, stats, transcribe };
}

/**
 * The route, kept out of index.mjs: returns {status, body} for the server's json() helper.
 * @param {ReturnType<typeof createTranscriber> | null} transcriber
 */
export function createTranscribeHandler(transcriber, { log = () => {} } = {}) {
  const fail = (status, code, message) => ({ status, body: { error: { code, message } } });
  return async function handle(req, url) {
    const t0 = performance.now();
    if (req.method !== "POST") return fail(405, "method_not_allowed", "use POST");
    if (!transcriber) return fail(503, "transcribe_off", "speech-to-text is off: start the server with OPENAI_API_KEY or OPENAI_API_KEY_FILE");
    const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!TYPES[mime]) return fail(415, "bad_audio_type", `content-type must be one of ${Object.keys(TYPES).join(", ")}`);
    const audioMs = req.headers["x-audio-ms"];
    if (audioMs !== undefined && (!/^\d+$/.test(String(audioMs)) || Number(audioMs) > MAX_AUDIO_MS)) {
      return fail(413, "audio_too_long", `X-Audio-Ms must be an integer up to ${MAX_AUDIO_MS}`);
    }
    const lang = url.searchParams.get("lang") ?? undefined;
    if (lang && !/^[a-z]{2}$/.test(lang)) return fail(400, "bad_lang", "lang must be an ISO-639-1 code like en");
    const prompt = (url.searchParams.get("prev") ?? "").replace(/\s+/g, " ").trim().slice(-200) || undefined;
    let audio;
    try { audio = await readBody(req, MAX_AUDIO_BYTES); } catch (error) {
      return error.code === "too_large" ? fail(413, "audio_too_large", `audio over ${MAX_AUDIO_BYTES} bytes`) : fail(400, "bad_body", "could not read the audio body");
    }
    if (audio.length < MIN_AUDIO_BYTES) return fail(400, "audio_too_short", `audio under ${MIN_AUDIO_BYTES} bytes`);
    const r = await transcriber.transcribe(audio, { mime, language: lang, prompt });
    if (!r.ok) {
      log(`transcribe failed (${r.code}): ${r.error}`);
      const status = r.code === "bad_audio" ? 422 : r.code === "rate_limited" ? 429 : r.code === "timeout" ? 504 : 502;
      return fail(status, `transcribe_${r.code}`, r.code === "bad_audio" ? "the speech-to-text service could not decode this audio" : "speech-to-text is unavailable right now");
    }
    return { status: 200, body: { text: r.text, model: r.model, timings: { transcribe_ms: r.latency_ms, total_ms: ms(performance.now() - t0) } } };
  };
}

/** Transcriber from the environment (same key as the agent layer), or null. Never under node --test unless AGENT_IN_TESTS=1. */
export function transcriberFromEnv(keyInfo, log = () => {}) {
  if (process.env.TRANSCRIBE === "off" || process.env.TRANSCRIBE === "0") return null;
  if (process.env.NODE_TEST_CONTEXT && process.env.AGENT_IN_TESTS !== "1") return null;
  if (!keyInfo?.key) return null;
  let OpenAI;
  try { OpenAI = createRequire(import.meta.url)("openai").OpenAI; } catch {
    log("transcribe off: the openai package is not installed (cd app/server && npm i)");
    return null;
  }
  const t = createTranscriber({ client: new OpenAI({ apiKey: keyInfo.key, maxRetries: 0 }), secrets: [keyInfo.key] });
  log(`transcribe: ${t.model} (timeout ${t.timeoutMs} ms)`);
  return t;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      else if (size > 4 * limit) { reject(Object.assign(new Error("too large"), { code: "too_large" })); req.destroy(); }
    });
    req.on("end", () => (size > limit ? reject(Object.assign(new Error("too large"), { code: "too_large" })) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

const ms = (x) => Math.round(x * 100) / 100;
