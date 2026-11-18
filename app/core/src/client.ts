import { FRAMES_HEADER, ROUTES, type ApiError, type ComposeRequest, type ComposeResponse, type EnrollInfo, type HealthResponse, type RecognizeMode, type RecognizeOptions, type RecognizeResponse, type SignRequest, type SignResponse, type SpeakRequest, type TranscribeResponse, type VocabResponse } from "./api.ts";
import { LEGACY_POINTS } from "./landmarks.ts";

export class SignApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
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
    /** Absolute URL of the 3D signer's avatar on this server. */
    modelUrl: () => abs(ROUTES.model),
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
      const playlist = safety.status === "fully_supported"
        ? res.playlist.map((p) => ({ ...p, url: p.url ? abs(p.url) : "", ...(p.motion_url ? { motion_url: abs(p.motion_url) } : {}) })) : [];
      return { ...res, safety, playlist, markers: playlist.length ? res.markers : [],
        ...(res.rest_motion_url ? { rest_motion_url: abs(res.rest_motion_url) } : {}) };
    },
    /** Sign -> voice: send one segment of packed landmark frames (landmarks.ts packSegment). With a profile (sign
     *  mode): the closed demo vocabulary and the person's own model; the answer lists every sign in the segment. */
    recognize(mode: RecognizeMode, frames: Float32Array, opts: AbortSignal | RecognizeOptions = {}): Promise<RecognizeResponse> {
      const o: RecognizeOptions = opts instanceof AbortSignal ? { signal: opts } : opts;
      const q = new URLSearchParams({ mode });
      if (o.profile && mode === "sign") { q.set("profile", o.profile); if (o.vocab?.length) q.set("vocab", o.vocab.join(",")); }
      const headers: Record<string, string> = { "content-type": "application/octet-stream", [FRAMES_HEADER]: String(frameCount(frames)) };
      if (o.fps) headers["x-fps"] = o.fps.toFixed(1);
      return request<RecognizeResponse>(`${ROUTES.recognize}?${q}`, { method: "POST", body: bytes(frames), headers, signal: o.signal });
    },
    /** "Train my signs": the profile's reps per sign, and whether it has a model. */
    enrollInfo: (profile: string) => request<EnrollInfo>(`${ROUTES.enroll}?profile=${encodeURIComponent(profile)}`),
    /** Store one rep (a segment of packed frames) of label for profile. */
    enroll(profile: string, label: string, frames: Float32Array): Promise<EnrollInfo> {
      return request<EnrollInfo>(`${ROUTES.enroll}?profile=${encodeURIComponent(profile)}&label=${encodeURIComponent(label)}`, {
        method: "POST", body: bytes(frames), headers: { "content-type": "application/octet-stream", [FRAMES_HEADER]: String(frameCount(frames)) },
      });
    },
    /** Forget a profile's reps of one label (or all of them). */
    unenroll: (profile: string, label?: string) =>
      request<EnrollInfo>(`${ROUTES.enroll}?profile=${encodeURIComponent(profile)}${label ? `&label=${encodeURIComponent(label)}` : ""}`, { method: "DELETE" }),
    /** Fit the profile's model (a few seconds). */
    train: (profile: string) => request<EnrollInfo>(`${ROUTES.train}?profile=${encodeURIComponent(profile)}`, { method: "POST", body: "{}" }),
    /** Sign -> voice: does this run of signs make sense yet, and as what English sentence. 503 compose_off without a key. */
    compose: (req: ComposeRequest, signal?: AbortSignal) => request<ComposeResponse>(ROUTES.compose, { method: "POST", body: JSON.stringify(req), signal }),
    /** Sign -> voice: the sentence as natural speech (audio/mpeg Blob). 503 speak_off without a key: use the device voice. */
    async speak(text: string, { voice, signal }: { voice?: string; signal?: AbortSignal } = {}): Promise<Blob> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const body: SpeakRequest = { text, ...(voice ? { voice } : {}) };
      try {
        const res = await fetch(base + ROUTES.speak, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ?? ctrl.signal });
        if (!res.ok) {
          const err = ((await res.json().catch(() => null)) as ApiError | null)?.error;
          throw new SignApiError(res.status, err?.code ?? "http_error", err?.message ?? `HTTP ${res.status}`);
        }
        return await res.blob();
      } finally {
        clearTimeout(timer);
      }
    },
    /** Speech -> text for one short audio chunk (MediaRecorder webm/opus or mp4/aac). text is "" for silence. */
    transcribe(audio: Blob, { lang = "en", ms, signal }: { lang?: string; ms?: number; signal?: AbortSignal } = {}): Promise<TranscribeResponse> {
      const type = (audio.type || "audio/webm").split(";")[0]!.trim();
      const headers: Record<string, string> = { "content-type": type };
      if (ms) headers["x-audio-ms"] = String(Math.min(30_000, Math.round(ms)));
      return request<TranscribeResponse>(`${ROUTES.transcribe}?lang=${lang}`, { method: "POST", body: audio, headers, signal });
    },
  };
}

function frameCount(frames: Float32Array): number {
  const n = frames.length / (LEGACY_POINTS * 3);
  if (!Number.isInteger(n) || n < 1) throw new Error("frames must be a whole number of 543x3 frames");
  return n;
}
const bytes = (f: Float32Array) => f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer;

export type SignClient = ReturnType<typeof createSignClient>;
