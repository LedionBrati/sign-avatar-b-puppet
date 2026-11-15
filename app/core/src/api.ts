// SIGNLAYER app contract: the local API (app/server) and every client (web, extension, mobile).
// Change this file first, then the server and clients.

/** One clip in the signing playlist. Clips start and end in the same neutral pose, so they play back to back. */
export interface PlaylistItem {
  motion_id: string; // catalog ID, e.g. "THANK_YOU"
  gloss: string; // display gloss, e.g. "THANK YOU"
  url: string; // clip URL (absolute, or relative to the API base)
  duration_s: number;
  /** Index into `words` of the spoken word this sign translates, -1 if none (for "Signing X for 'word'"). */
  word_index: number;
}

/** POST /api/sign request. */
export interface SignRequest {
  text: string;
  /** Default true. false = rules only (sub-millisecond, no local model). */
  semantic?: boolean;
  /**
   * LLM agent layer (server-side, OpenAI). Default "auto": only when the local translator is not fully supported,
   * and only used if the safety gate rates the agent plan better. "always": prefer the agent plan. "off": local only.
   * With the agent on, the sentence text is sent to OpenAI.
   */
  agent?: AgentMode;
}

export type AgentMode = "auto" | "always" | "off";

/** Debug trace of the agent call, present whenever the agent was asked. */
export interface AgentTrace {
  /** true when this response's playlist/safety/plan come from the agent. */
  used: boolean;
  /** Safety status of the agent plan and of the local plan. */
  status?: SigningSafety["status"];
  local_status: SigningSafety["status"];
  paraphrase?: string;
  notes?: string;
  model?: string;
  cached?: boolean;
  latency_ms?: number;
  usage?: { input_tokens: number; output_tokens: number; cached_tokens: number } | null;
  /** Proposed items that failed validation (e.g. a motion_id not in the vocab); never played. */
  rejected?: { reason: string; id?: string | null; letters?: string | null; source?: string | number | null }[];
  /** One-line summary of the plan that was NOT returned ("~" marks a paraphrased sign). */
  plan?: string;
  local_plan?: string;
  /** Set when the agent failed and the local result was returned. */
  code?: string;
  error?: string;
}

/** Engineering playback decision; it does not certify linguistic ASL correctness. */
export interface SigningSafety {
  status: "fully_supported" | "needs_confirmation" | "caption_only";
  /** Exact request text, including original whitespace and punctuation. */
  caption: string;
  reasons: {
    code: string;
    tokens: string[];
    next_action: string;
    item_index?: number;
    motion_id?: string;
    proposed_gloss?: string;
    score?: number;
    missing_letters?: string[];
    detail?: string;
  }[];
  next_actions: string[];
}

/** POST /api/sign response. */
export interface SignResponse {
  text: string;
  /** Always present from the local server; optional for older clients and the mock API. */
  safety?: SigningSafety;
  /** The input split into display words, in spoken order (captions). */
  words: string[];
  /** Signs in signing order (ASL order can differ from `words`). Empty unless safety is fully_supported. */
  playlist: PlaylistItem[];
  /** Words we could not sign (shown in captions, never invented). */
  unsupported: string[];
  /** Names the translator wanted to fingerspell; skipped until A-Z letter clips exist. */
  fingerspell: string[];
  /** Approximate facial-grammar markers over playlist indices (inclusive). */
  markers: { type: string; from: number; to: number }[];
  /** The full translator plan (shared/contracts.mjs format) for debugging. */
  plan: unknown;
  /** Which translator produced this response. Older servers omit it (= "local"). */
  translator?: "local" | "agent";
  /** translator "agent" only: the English the signs actually express (show it for needs_confirmation). */
  paraphrase?: string;
  agent?: AgentTrace;
  /** Non-fatal notes, e.g. "agent unavailable (timeout); local translation used". */
  warnings?: string[];
  /**
   * Signs this sentence needs that have motion but no realistic clip yet: the server is generating them in the
   * background (generate-on-use). This response is NOT delayed; it stays caption-only for those words. Once a clip
   * is ready (about 2–3 min), the next request with that word signs it. Absent when nothing is generating.
   */
  generating?: GeneratingSign[];
  timings: { translate_ms: number; agent_ms?: number; total_ms: number };
}

/** A sign being generated on demand (`SignResponse.generating`). */
export interface GeneratingSign {
  motion_id: string;
  gloss: string;
  /** Estimated seconds until the clip is available. */
  eta_s: number;
}

/** GET /api/vocab response: the signs that have clips right now. */
export interface VocabResponse {
  signs: { motion_id: string; gloss: string; duration_s: number }[];
}

export interface HealthResponse {
  ok: true;
  signs: number;
  semantic: "ready" | "loading" | "off";
  /** LLM agent layer: "ready" when an OpenAI key is configured. Older servers omit it. */
  agent?: "ready" | "off";
  /** POST /api/transcribe (speech-to-text for tab audio): "ready" when an OpenAI key is configured. Older servers omit it. */
  transcribe?: "ready" | "off";
  /** Sign -> voice recognizer service status. */
  recognizer?: "ready" | "down";
  /** POST /api/compose (signs -> spoken sentence by meaning): "ready" when an OpenAI key is configured. Older servers omit it. */
  compose?: "ready" | "off";
  /** POST /api/speak (text -> natural voice, audio/mpeg): "ready" when an OpenAI key is configured. Older servers omit it. */
  speak?: "ready" | "off";
  /** Generate-on-use (server ONDEMAND=on). Omitted when the server has it off. */
  ondemand?: OnDemandHealth;
}

export interface OnDemandHealth {
  enabled: boolean;
  /** Signs waiting / in the batch being rendered. */
  queued: number;
  running: number;
  done_today: number;
  /** Conservative fal reserve spent today (USD), counted against the server's daily budget. */
  spent_today_est: number;
}

/**
 * POST /api/transcribe. Body: one short audio chunk (audio/webm opus from MediaRecorder; also ogg, wav, mpeg, mp4),
 * up to 2 MB. Query: lang=en (optional), prev=<last words of the previous chunk, for continuity> (optional).
 * Header X-Audio-Ms (optional, max 30000). text is "" for silence / music.
 */
export interface TranscribeResponse {
  text: string;
  model: string;
  timings: { transcribe_ms: number; total_ms: number };
}

export interface ApiError {
  error: { code: string; message: string };
}

// ── Sign -> voice ──────────────────────────────────────────────────────────────
export type RecognizeMode = "sign" | "spell";

/** POST /api/recognize?mode=sign|spell. Body: float32 [frames x 543 x 3] (see landmarks.ts), header X-Frames. */
export interface RecognizeResponse {
  mode: RecognizeMode;
  /** mode=sign: top-5 recognizer labels (GISLR vocabulary, e.g. "hello", "thankyou") with softmax confidence. */
  options: { label: string; text: string; confidence: number }[];
  /** mode=spell: decoded fingerspelled letters, e.g. "MARIA". */
  text?: string;
  frames: number;
  timings: { inference_ms: number; total_ms: number };
  motion?: number;
  reject?: boolean;
}

/** POST /api/compose. The signs read so far (1-8), each with the recognizer's guesses (best first, up to 5). */
export interface ComposeRequest {
  signs: { text: string; options?: { text: string; confidence: number }[] }[];
  /** Optional conversation context: the last <= 2 sentences this screen spoke, the last thing the hearing person said. */
  context?: {
    said?: string[];
    heard?: string;
    history?: { who: "them" | "me"; text: string }[];
  };
}

/** makes_sense: the signs already form a complete message. sentence: natural English (best effort even if not).
 *  picked: which guess was used per sign; -1 = the sign was dropped (every guess low-confidence and none fit). */
export interface ComposeResponse {
  makes_sense: boolean;
  sentence: string;
  picked: number[];
  model: string;
  cached: boolean;
  latency_ms: number;
}

/** POST /api/speak. text <= 400 chars; voice: an OpenAI TTS voice (server default "coral"). Answer: audio/mpeg bytes. */
export interface SpeakRequest {
  text: string;
  voice?: string;
}

export const FRAMES_HEADER = "X-Frames";

export const ROUTES = {
  health: "/api/health", // GET -> HealthResponse
  vocab: "/api/vocab", // GET -> VocabResponse
  sign: "/api/sign", // POST SignRequest -> SignResponse
  ondemand: "/api/ondemand", // GET generate-on-use status (queue, spend, recent batches)
  clips: "/clips/", // GET /clips/<file>.mp4 (static)
  transcribe: "/api/transcribe", // POST audio/webm chunk -> TranscribeResponse
  compose: "/api/compose", // POST ComposeRequest -> ComposeResponse (signs -> sentence, OpenAI)
  speak: "/api/speak", // POST SpeakRequest -> audio/mpeg (natural text-to-speech, OpenAI)
  recognize: "/api/recognize", // POST ?mode=sign|spell, octet-stream float32 frames -> RecognizeResponse (proxied to app/recognizer)
  webApp: "/app/", // GET the built web app (phone WebView loads /app/#/sign?embed=1)
} as const;

export const DEFAULT_PORT = 8787;
