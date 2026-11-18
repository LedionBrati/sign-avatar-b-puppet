// The HTTP router: every route of the API (index.mjs header), the recognizer proxy and the joined mp4.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTES } from "../../core/src/api.ts";
import { LEGACY_POINTS, MAX_FRAMES } from "../../core/src/landmarks.ts";
import { joinClips } from "../../../pipeline/lib/clips.mjs";
import { parseContext, parseSigns } from "./compose.mjs";
import { HttpError, cors, json, only, readJson, readRaw } from "./http.mjs";
import { parseSpeak } from "./speak.mjs";
import { MIME, sendFile, sendMotion, sendWebApp } from "./static.mjs";

/** MAX_FRAMES frames x 543 points x 3 floats x 4 bytes (app/core/src/landmarks.ts). */
export const MAX_RECOGNIZE_BODY = MAX_FRAMES * LEGACY_POINTS * 3 * 4;
const PROFILES = "/api/profiles";
const ROUTE_LIST = [ROUTES.health, ROUTES.vocab, ROUTES.ondemand, `POST ${ROUTES.sign}`, `${ROUTES.sign}.mp4?text=`, `${ROUTES.clips}<file>`,
  `POST ${ROUTES.transcribe}`, `POST ${ROUTES.recognize}?mode=sign|spell`, `GET|POST|DELETE ${ROUTES.enroll}`, `POST ${ROUTES.train}`, PROFILES,
  `POST ${ROUTES.compose}`, `POST ${ROUTES.speak}`, `${ROUTES.motion}<stem>.json`, ROUTES.model, ROUTES.webApp];

/**
 * @param {object} c
 * @param {object} c.cfg          lib/config.mjs serverConfig (recognizerUrl, webDist, evalVocab)
 * @param {object} c.lib          sign-pipeline.mjs createClipLibrary
 * @param {object} c.pipeline     sign-pipeline.mjs createSignPipeline (sign, state)
 * @param {object|null} c.motions
 * @param {object} c.ondemand
 * @param {boolean} c.ondemandWanted  ONDEMAND was set (health shows its status even when it is off)
 * @param {Function} c.transcribe     lib/transcribe.mjs createTranscribeHandler
 * @param {object|null} c.transcriber
 * @param {object|null} c.composer
 * @param {object|null} c.speaker
 * @param {(s: unknown) => string} c.redact
 * @param {(line: string) => void} c.log
 * @returns {(req, res) => Promise<void>}
 */
export function createRouter({ cfg, lib, pipeline, motions, ondemand, ondemandWanted, transcribe, transcriber, composer, speaker, redact, log }) {
  const { recognizerUrl, webDist, evalVocab } = cfg;
  const { sign, state } = pipeline;

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-max-age": "86400" }); return res.end(); }

    if (path === ROUTES.health) {
      only(req, "GET", "HEAD");
      return json(res, 200, { ok: true, signs: lib.clips.signs.size, semantic: state.semantic, agent: state.agent, transcribe: transcriber ? "ready" : "off", compose: composer ? "ready" : "off", speak: speaker ? "ready" : "off", recognizer: await recognizerStatus(),
        ...(ondemandWanted || ondemand.enabled ? { ondemand: ondemand.health() } : {}),
        ...(motions ? { motion: { signs: motions.size, model: Boolean(motions.model), semantic: state.semantic_motion } } : {}) });
    }
    if (path === ROUTES.ondemand) {
      only(req, "GET", "HEAD");
      return json(res, 200, ondemand.status());
    }
    if (path === ROUTES.vocab) {
      only(req, "GET", "HEAD");
      return json(res, 200, { signs: [...lib.clips.signs.values()].map(({ motion_id, gloss, duration_s }) => ({ motion_id, gloss, duration_s })) });
    }
    if (path === ROUTES.sign) {
      only(req, "POST");
      return json(res, 200, await sign(await readJson(req)));
    }
    if (path === `${ROUTES.sign}.mp4`) {
      only(req, "GET");
      const result = await sign({ text: url.searchParams.get("text") ?? "", semantic: url.searchParams.get("semantic") !== "false",
        agent: url.searchParams.get("agent") ?? "auto" });
      if (result.safety.status !== "fully_supported") {
        return json(res, 422, { text: result.text, playlist: [], safety: result.safety,
          error: { code: "signing_not_supported", message: "Full signing is not available for this message" } });
      }
      if (evalVocab) throw new HttpError(409, "eval_mode", "EVAL_VOCAB server has virtual clips; nothing to join");
      return sendJoined(req, res, result);
    }
    if (path === ROUTES.transcribe) {
      const r = await transcribe(req, url);
      return json(res, r.status, r.body);
    }
    if (path === ROUTES.compose) {
      only(req, "POST");
      if (!composer) throw new HttpError(503, "compose_off", "no OpenAI key on the server; compose the sentence on the client");
      let signs, context;
      try { const body = await readJson(req); signs = parseSigns(body); context = parseContext(body); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, "bad_request", e.message); }
      try { return json(res, 200, { ok: true, ...(await composer.compose(signs, context)) }); } catch (e) {
        log(`compose failed: ${redact(e?.message ?? String(e))}`);
        throw new HttpError(502, "compose_failed", "the sentence model did not answer");
      }
    }
    if (path === ROUTES.speak) {
      only(req, "POST");
      if (!speaker) throw new HttpError(503, "speak_off", "no OpenAI key on the server; use the device's own voice");
      let input;
      try { input = parseSpeak(await readJson(req)); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(e.status ?? 400, e.code ?? "bad_request", e.message); }
      let out;
      try { out = await speaker.speak(input.text, { voice: input.voice }); } catch (e) {
        log(`speak failed (${e?.code ?? "upstream"}): ${redact(e?.message ?? String(e))}`);   // never the text
        throw new HttpError(e?.code === "timeout" ? 504 : e?.code === "rate_limited" ? 429 : 502, "speak_failed", "the voice service did not answer");
      }
      res.writeHead(200, { "content-type": "audio/mpeg", "content-length": out.audio.length, "cache-control": "no-store", "x-speak-cached": out.cached ? "1" : "0" });
      return res.end(out.audio);
    }
    if (path === ROUTES.recognize) {
      only(req, "POST");
      return recognize(req, res, url);
    }
    if (path === ROUTES.enroll || path === ROUTES.train || path === PROFILES) {
      if (path === ROUTES.enroll) only(req, "GET", "POST", "DELETE");
      else if (path === ROUTES.train) only(req, "POST");
      else only(req, "GET");
      return enrollProxy(req, res, url);
    }
    if (path === "/app") { res.writeHead(301, { location: ROUTES.webApp + url.search }); return res.end(); }
    if (path.startsWith(ROUTES.webApp)) {
      only(req, "GET", "HEAD");
      return sendWebApp(req, res, path, webDist);
    }
    if (path.startsWith(ROUTES.motion)) {
      only(req, "GET", "HEAD");
      let stem;
      try { stem = decodeURIComponent(path.slice(ROUTES.motion.length)).replace(/\.json$/, ""); } catch { stem = null; }
      const entry = stem && motions ? motions.get(stem) : null;
      if (!entry) throw new HttpError(404, "no_motion", `no motion ${stem ?? path}`);
      return sendMotion(req, res, entry);
    }
    if (path === ROUTES.model) {
      only(req, "GET", "HEAD");
      if (!motions?.model) throw new HttpError(404, "no_model", "no 3D signer model on this server (set SIGNER_MODEL or copy puppet/models/signer.glb)");
      return sendFile(req, res, motions.model, { cache: "public, max-age=86400", type: MIME[".glb"] });
    }
    if (path.startsWith(ROUTES.clips)) {
      only(req, "GET", "HEAD");
      let rel;
      try { rel = decodeURIComponent(path.slice(ROUTES.clips.length)); } catch { rel = null; }
      const file = rel && lib.clips.files.get(rel);
      if (!file) throw new HttpError(404, "no_clip", `no clip ${rel ?? path}`);
      return sendFile(req, res, file);
    }
    if (path === "/") return json(res, 200, { name: "flux-server", routes: ROUTE_LIST });
    throw new HttpError(404, "not_found", `no route ${req.method} ${path}`);
  }

  async function recognizerStatus() {
    try {
      const r = await fetch(`${recognizerUrl}/health`, { signal: AbortSignal.timeout(800) });
      return r.ok ? "ready" : "down";
    } catch { return "down"; }
  }

  // Sign -> voice: pass the raw float32 body + X-Frames through to the Python recognizer. Never logs the body (biometric).
  async function recognize(req, res, url) {
    const mode = url.searchParams.get("mode") ?? "sign";
    if (mode !== "sign" && mode !== "spell") throw new HttpError(400, "bad_mode", "mode must be sign or spell");
    const frames = req.headers["x-frames"];
    if (!frames || !/^\d+$/.test(String(frames))) throw new HttpError(400, "bad_frames", "X-Frames header must be a positive integer");
    const body = await readRaw(req, MAX_RECOGNIZE_BODY);
    const q = new URLSearchParams({ mode });
    for (const k of ["profile", "vocab"]) { const v = url.searchParams.get(k); if (v) q.set(k, v.slice(0, 400)); }
    const fps = req.headers["x-fps"];
    let upstream;
    try {
      upstream = await fetch(`${recognizerUrl}/recognize?${q}`, {
        method: "POST", body, headers: { "content-type": "application/octet-stream", "x-frames": String(frames), ...(fps && /^[\d.]+$/.test(String(fps)) ? { "x-fps": String(fps) } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new HttpError(503, "recognizer_down", `recognizer not reachable at ${recognizerUrl} (start it: cd app/recognizer && uv run python server.py)`);
    }
    return json(res, upstream.status, await upstreamJson(upstream));
  }

  // "Train my signs": enroll / train / profiles go straight to the recognizer (it owns the reps and the models).
  async function enrollProxy(req, res, url) {
    const q = new URLSearchParams();
    for (const k of ["profile", "label"]) { const v = url.searchParams.get(k); if (v) q.set(k, v.slice(0, 64)); }
    const headers = { "content-type": "application/octet-stream" };
    let body;
    if (req.method === "POST" && url.pathname === ROUTES.enroll) {
      const frames = req.headers["x-frames"];
      if (!frames || !/^\d+$/.test(String(frames))) throw new HttpError(400, "bad_frames", "X-Frames header must be a positive integer");
      headers["x-frames"] = String(frames);
      body = await readRaw(req, MAX_RECOGNIZE_BODY);
    } else if (req.method === "POST") await readRaw(req, 1024);
    let upstream;
    try {
      upstream = await fetch(`${recognizerUrl}${url.pathname.slice(4)}?${q}`, { method: req.method, body, headers, signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new HttpError(503, "recognizer_down", `recognizer not reachable at ${recognizerUrl} (start it: cd app/recognizer && uv run python server.py)`);
    }
    return json(res, upstream.status, await upstreamJson(upstream));
  }

  // GET /api/sign.mp4: the playlist joined into one mp4 with ffmpeg stream copy (pipeline/lib/clips.mjs joinClips).
  function sendJoined(req, res, result) {
    if (!result.playlist.length) throw new HttpError(422, "nothing_to_sign", `nothing in this text has a clip (unsupported: ${result.unsupported.join(", ") || "none"})`);
    const ids = result.playlist.map((p, i) => `${p.motion_id}#${i}`);
    const byId = new Map([...lib.clips.signs.values(), ...lib.clips.letters.values()].map((c) => [c.motion_id, c]));
    const manifest = Object.fromEntries(result.playlist.map((p, i) => [ids[i], { file: byId.get(p.motion_id).path, seconds: p.duration_s }]));
    const dir = mkdtempSync(join(tmpdir(), "flux-"));
    const out = join(dir, "sign.mp4");
    try {
      const joined = joinClips({ clipsDir: dir, ids, out, manifest });
      if (!joined.ok) throw new HttpError(500, "join_failed", "could not join clips");
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, "join_failed", `ffmpeg failed: ${error.message}`);
    }
    res.on("close", () => rmSync(dir, { recursive: true, force: true }));
    res.setHeader("content-disposition", 'inline; filename="sign.mp4"');
    res.setHeader("x-flux-unsupported", encodeURIComponent(result.unsupported.join(" ")));
    return sendFile(req, res, out, { cache: "no-store" });
  }

  return handle;
}

async function upstreamJson(upstream) {
  const text = await upstream.text();
  try { return JSON.parse(text); } catch { throw new HttpError(502, "bad_upstream", "recognizer returned non-JSON"); }
}
