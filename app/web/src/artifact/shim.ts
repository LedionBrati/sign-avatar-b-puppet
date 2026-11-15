// In-page sign API for the artifact build: there is no server, so `/api/*` is answered right here.
// Loaded before the app (src/artifact/entry.ts). It wraps window.fetch and serves any request whose path starts with
// /api/ (whatever the host, so a stale server setting still lands here); everything else (the clips, fonts) goes to
// the network untouched. /api/sign is the live server's code path in rules-only, relaxed mode:
//   translate/ translateRules -> app/server/lib/sign.mjs planToPlaylist -> semantic-safety assessSigning -> relaxed.
// The semantic layer (transformers.js) is never called and is aliased to a stub in the build.
import type { HealthResponse, SignResponse, SigningSafety, VocabResponse } from "@signlayer/core";
import { CLIPS } from "virtual:artifact-clips";
import { translateRules } from "@sl/translate";
import { planToPlaylist, type ArtifactClip, type ArtifactClipSets } from "@sl/sign";
import { assessSigning } from "@sl/safety";

const MAX_TEXT = 500; // app/server MAX_TEXT
const AGENT_MODES = ["auto", "always", "off"];

// Clip URLs are absolute (resolved against the page), so the client never prefixes an API base.
const clipUrl = (file: string) => new URL(file, location.href).href;
const signs = new Map<string, ArtifactClip>(CLIPS.map((c) => [c.motion_id, { motion_id: c.motion_id, gloss: c.gloss, url: clipUrl(c.file), duration_s: c.duration_s }]));
const clipSets: ArtifactClipSets = { signs, letters: new Map() }; // no A-Z letter clips are bundled
const vocab = CLIPS.map(({ motion_id, gloss }) => ({ motion_id, gloss }));

class ApiFail extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const ms = (x: number) => Math.round(x * 1000) / 1000;

/** POST /api/sign, same validation and response shape as app/server (SIGNING_MODE=relaxed, no agent, no semantic). */
export function sign(body: unknown): SignResponse {
  const t0 = performance.now();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiFail(400, "bad_request", "body must be a JSON object {text, semantic?, agent?}");
  const { text, semantic = true, agent = "auto" } = body as { text?: unknown; semantic?: unknown; agent?: unknown };
  if (typeof text !== "string") throw new ApiFail(400, "bad_text", "text must be a string");
  if (!text.trim()) throw new ApiFail(400, "empty_text", "text is empty");
  if (text.length > MAX_TEXT) throw new ApiFail(413, "text_too_long", `text is ${text.length} characters; the limit is ${MAX_TEXT}`);
  if (typeof semantic !== "boolean") throw new ApiFail(400, "bad_semantic", "semantic must be a boolean");
  if (typeof agent !== "string" || !AGENT_MODES.includes(agent)) throw new ApiFail(400, "bad_agent", `agent must be one of ${AGENT_MODES.join(", ")}`);

  const t1 = performance.now();
  const plan = translateRules(text, vocab);
  const translate_ms = ms(performance.now() - t1);
  const out = planToPlaylist(plan, clipSets);
  const strict = assessSigning(text, plan, clipSets);
  const invalid = strict.reasons.some((r) => r.code === "invalid_plan");
  let safety: SigningSafety & { strict_status?: string; mode?: string } = strict;
  if (strict.status !== "fully_supported") {
    if (!invalid && out.playlist.length) {
      // Relaxed (the live server's mode): sign what we can, keep the strict verdict for reference.
      safety = { ...strict, status: "fully_supported", strict_status: strict.status, mode: "relaxed" };
    } else {
      out.playlist = [];
      out.markers = [];
      if (strict.status !== "caption_only") safety = { ...strict, status: "caption_only", strict_status: strict.status, mode: "relaxed" };
    }
  }
  return {
    text, ...out, safety, plan, translator: "local",
    timings: { translate_ms, total_ms: ms(performance.now() - t0) },
  };
}

export function health(): HealthResponse {
  return { ok: true, signs: signs.size, semantic: "off", agent: "off", transcribe: "off", recognizer: "down" };
}

export function vocabResponse(): VocabResponse {
  return { signs: CLIPS.map(({ motion_id, gloss, duration_s }) => ({ motion_id, gloss, duration_s })) };
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });

async function handle(path: string, method: string, read: () => Promise<string>): Promise<Response> {
  if (method === "OPTIONS") return new Response(null, { status: 204 });
  const get = method === "GET" || method === "HEAD";
  try {
    if (path === "/api/health") return get ? reply(200, health()) : fail(405, "method_not_allowed", `${method} not allowed`);
    if (path === "/api/vocab") return get ? reply(200, vocabResponse()) : fail(405, "method_not_allowed", `${method} not allowed`);
    if (path === "/api/sign") {
      if (method !== "POST") return fail(405, "method_not_allowed", `${method} not allowed`);
      let body: unknown;
      try { body = JSON.parse(await read()); } catch { return fail(400, "bad_json", "body is not valid JSON"); }
      return reply(200, sign(body));
    }
    if (path === "/api/ondemand") return reply(200, { enabled: false, reason: "artifact build: no generation" });
    // Camera / audio features are not part of the artifact build.
    if (path === "/api/recognize" || path === "/api/transcribe") return fail(503, "unavailable", "Not available in this build. Try the full app.");
    return fail(404, "not_found", `no route ${path}`);
  } catch (e) {
    if (e instanceof ApiFail) return fail(e.status, e.code, e.message);
    return fail(500, "internal", (e as Error).message);
  }
}

/** The /api/ path of a fetch target, or null when it is not an API call. */
function apiPath(input: RequestInfo | URL): string | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let u: URL;
  try { u = new URL(raw, location.href); } catch { return null; }
  return u.pathname.startsWith("/api/") ? u.pathname.replace(/\/+$/, "") : null;
}

export function installShim() {
  const w = window as unknown as { __slShim?: boolean };
  if (w.__slShim) return;
  w.__slShim = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = apiPath(input);
    if (!path) return realFetch(input, init);
    const req = input instanceof Request ? input : null;
    const signal = init?.signal ?? req?.signal;
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const read = async () => {
      const b = init?.body;
      if (typeof b === "string") return b;
      if (b == null) return req ? req.clone().text() : "";
      return new Response(b).text();
    };
    return handle(path, method, read);
  };
}

installShim();
