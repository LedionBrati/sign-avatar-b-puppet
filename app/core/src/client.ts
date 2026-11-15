import { FRAMES_HEADER, ROUTES, type ApiError, type ComposeRequest, type ComposeResponse, type HealthResponse, type RecognizeMode, type RecognizeResponse, type SignRequest, type SignResponse, type TranscribeResponse, type VocabResponse } from "./api";
import { LEGACY_POINTS } from "./landmarks";

export class SignApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "SignApiError";
  }
}

/** Works in browsers, the extension and React Native (all have fetch + AbortController). */
export function createSignClient(baseUrl: string, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}) {
  const base = baseUrl.replace(/\/$/, "");
  const abs = (url: string) => (/^https?:/i.test(url) ? url : base + (url.startsWith("/") ? url : `/${url}`));

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        signal: init.signal ?? ctrl.signal,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = (body as ApiError | null)?.error;
        throw new SignApiError(res.status, err?.code ?? "http_error", err?.message ?? `HTTP ${res.status}`);
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    base,
    health: () => request<HealthResponse>(ROUTES.health),
    vocab: () => request<VocabResponse>(ROUTES.vocab),
    /** Translate text and get the playlist. Clip URLs are made absolute. */
    async sign(req: SignRequest, signal?: AbortSignal): Promise<SignResponse> {
      const res = await request<SignResponse>(ROUTES.sign, { method: "POST", body: JSON.stringify(req), signal });
      const safety = res.safety ?? {
        status: "caption_only" as const, caption: req.text,
        reasons: [{ code: "missing_safety_decision", tokens: [], next_action: "Update the sign server before signing this message." }],
        next_actions: ["Update the sign server before signing this message."],
      };
      // An older or inconsistent server must never make a partial playlist playable.
      const playlist = safety.status === "fully_supported" ? res.playlist.map((p) => ({ ...p, url: abs(p.url) })) : [];
      return { ...res, safety, playlist, markers: playlist.length ? res.markers : [] };
    },
    /** Sign -> voice: send one segment of packed landmark frames (landmarks.ts packSegment). */
    recognize(mode: RecognizeMode, frames: Float32Array, signal?: AbortSignal): Promise<RecognizeResponse> {
      const n = frames.length / (LEGACY_POINTS * 3);
      if (!Number.isInteger(n) || n < 1) throw new Error("frames must be a whole number of 543x3 frames");
      return request<RecognizeResponse>(`${ROUTES.recognize}?mode=${mode}`, {
        method: "POST",
        body: frames.buffer.slice(frames.byteOffset, frames.byteOffset + frames.byteLength) as ArrayBuffer,
        headers: { "content-type": "application/octet-stream", [FRAMES_HEADER]: String(n) },
        signal,
      });
    },
    /** Sign -> voice: does this run of signs make sense yet, and as what English sentence. 503 compose_off without a key. */
    compose: (req: ComposeRequest, signal?: AbortSignal) => request<ComposeResponse>(ROUTES.compose, { method: "POST", body: JSON.stringify(req), signal }),
    /** Speech -> text for one short audio chunk (MediaRecorder webm/opus or mp4/aac). text is "" for silence. */
    transcribe(audio: Blob, { lang = "en", ms, signal }: { lang?: string; ms?: number; signal?: AbortSignal } = {}): Promise<TranscribeResponse> {
      const type = (audio.type || "audio/webm").split(";")[0]!.trim();
      const headers: Record<string, string> = { "content-type": type };
      if (ms) headers["x-audio-ms"] = String(Math.min(30_000, Math.round(ms)));
      return request<TranscribeResponse>(`${ROUTES.transcribe}?lang=${lang}`, { method: "POST", body: audio, headers, signal });
    },
  };
}

export type SignClient = ReturnType<typeof createSignClient>;
