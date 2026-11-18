// Flux local API (contract: app/core/src/api.ts). Plain node:http, no framework.
//
//   node app/server/index.mjs            PORT=8787, CLIPS_DIR=dir[,dir2,...], SEMANTIC=0 to disable embeddings
//                                        (out/realtime/clips-v2-{demo,sentences,library} are added in front; CLIPS_V2=0 off)
//                                        OPENAI_API_KEY / OPENAI_API_KEY_FILE enable the agent layer (AGENT=off disables)
//                                        ONDEMAND=on + FAL_KEY_FILE + MOTION_DIRS: generate missing clips on use (lib/ondemand.mjs)
//
//   GET  /api/health          {ok, signs, semantic: "ready" | "loading" | "off", agent: "ready" | "off", ondemand?}
//   GET  /api/ondemand        on-demand generator status: queue, spend, recent batches
//   GET  /api/vocab           {signs: [{motion_id, gloss, duration_s}]}
//   POST /api/sign            {text, semantic?, agent?: "auto"|"always"|"off"} -> words, playlist, unsupported, fingerspell,
//                             markers, plan, safety, translator: "local"|"agent", paraphrase?, generating?, timings
//   GET  /api/sign.mp4?text=  the playlist joined into one mp4 (ffmpeg stream copy), for sharing / download
//   GET  /clips/<file>        clips from the manifests, with HTTP Range (206) for Safari / iOS / expo-video
//   POST /api/sign {motion: true}   the client can play the instant 3D signer: signs with extracted motion but no clip
//                             are signable too; every playlist item carries motion_url ("" url = no photoreal clip)
//   GET  /motion/<stem>.json  slim motion file for the 3D signer (lib/motions.mjs; MOTION_DIRS, MOTION_V2_DIRS, MOTION=off)
//   GET  /models/signer.glb   the 3D signer's avatar (SIGNER_MODEL, default puppet/models/signer.glb)
//   POST /api/transcribe      raw audio chunk (audio/webm, ...) -> {text, model, timings}; same OpenAI key (lib/transcribe.mjs)
//   POST /api/recognize?mode=sign|spell   float32 landmarks + X-Frames, proxied to app/recognizer (RECOGNIZER_URL, default :8788)
//                             &profile=&vocab=A,B (+ X-Fps): closed demo vocabulary with a personal model, answer has signs[]
//   GET|POST|DELETE /api/enroll?profile=[&label=]   "Train my signs": reps stored by app/recognizer (out/enroll/, no face)
//   POST /api/train?profile=  fit the profile's model;  GET /api/profiles
//   POST /api/compose         {signs: [{text, options?, reject?}], context?: {said?, heard?, history?}} -> {makes_sense, sentence, picked}: recognized signs ->
//                             spoken English (same OpenAI key; lib/compose.mjs; COMPOSE=off disables)
//   POST /api/speak           {text, voice?} -> audio/mpeg, natural text-to-speech (same OpenAI key; lib/speak.mjs; SPEAK=off)
//   GET  /app/*               the built web app (app/web/dist, WEB_DIST), SPA fallback to index.html

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { translate, translateRules } from "../../translate/index.mjs";
import { createNodeMatcher, loadEnglishWords, loadVocab } from "../../translate/node.mjs";
import { joinClips } from "../../pipeline/lib/clips.mjs";
import { loadClipSets, parseClipsDirs, withV2Clips } from "./lib/clips.mjs";
import { planToPlaylist } from "./lib/sign.mjs";
import { assessSigning } from "./lib/semantic-safety.mjs";
import { createAgent } from "./lib/agent.mjs";
import { loadApiKey, loadFalKey, redactor } from "./lib/secrets.mjs";
import { createOnDemand, onDemandConfig, prepareClipsDir } from "./lib/ondemand.mjs";
import { createMotionLibrary, motionConfig } from "./lib/motions.mjs";
import { virtualClips } from "./lib/eval-vocab.mjs";
import { TRANSCRIBE_ROUTE, createTranscribeHandler, transcriberFromEnv } from "./lib/transcribe.mjs";
import { COMPOSE_ROUTE, createComposer, parseContext, parseSigns } from "./lib/compose.mjs";
import { SPEAK_ROUTE, parseSpeak, speakerFromEnv } from "./lib/speak.mjs";

export const MAX_TEXT = 500;
const MAX_BODY = 16 * 1024;
/** 384 frames x 543 points x 3 floats x 4 bytes (app/core/src/landmarks.ts MAX_FRAMES). */
export const MAX_RECOGNIZE_BODY = 384 * 543 * 3 * 4;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIST = resolve(HERE, "../web/dist");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".wasm": "application/wasm", ".task": "application/octet-stream",
  ".tflite": "application/octet-stream", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
  ".glb": "model/gltf-binary",
};
const ms = (x) => Math.round(x * 100) / 100;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/**
 * @param {object} [o]
 * @param {string[]} [o.clipsDirs]  default: CLIPS_DIR env (comma-separated) or <repo>/out/realtime/clips (lib/clips.mjs)
 * @param {boolean} [o.semantic]    default: SEMANTIC env != "0"; warms the local model in the background
 * @param {object} [o.matcher]      SemanticMatcher override (tests)
 * @param {string} [o.recognizerUrl]  default: RECOGNIZER_URL env or http://127.0.0.1:8788
 * @param {string} [o.webDist]        default: WEB_DIST env or app/web/dist
 * @param {object|null} [o.agent]     agent override ({plan(text, vocab, opts)}, see lib/agent.mjs); null = off.
 *                                    Default: from OPENAI_API_KEY / OPENAI_API_KEY_FILE unless AGENT=off (never under node --test)
 * @param {string} [o.evalVocab]      DEV/EVAL ONLY: "dictionary" (EVAL_VOCAB env) plans against the 1,945-sign dictionary
 *                                    with virtual clips; responses are labelled eval: "virtual_clips" and are never playable
 * @param {object|null} [o.ondemand]  generate-on-use options for lib/ondemand.mjs createOnDemand (tests inject fake steps);
 *                                    null = off. Default: from the environment (ONDEMAND=on, FAL_KEY_FILE / FAL_KEY, MOTION_DIRS),
 *                                    never under node --test
 * @param {object|null} [o.motion]    3D signer motion library settings for lib/motions.mjs createMotionLibrary
 *                                    ({dirs, v2Dirs, rest, model, minHandPct}); null = off. Default: from the environment
 *                                    (MOTION_DIRS, MOTION_V2_DIRS, MOTION_REST, SIGNER_MODEL; MOTION=off), never under node --test
 * @param {object|null} [o.transcriber]  speech-to-text override ({transcribe(audio, opts)}, see lib/transcribe.mjs); null = off
 * @param {object|null} [o.composer]  sign -> sentence override ({compose(signs, context)}, see lib/compose.mjs); null = off
 * @param {object|null} [o.speaker]   text -> speech override ({speak(text, {voice})}, see lib/speak.mjs); null = off
 * @param {(line: string) => void} [o.log]
 */
export function createApp(o = {}) {
  const recognizerUrl = (o.recognizerUrl ?? process.env.RECOGNIZER_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "");
  const webDist = resolve(o.webDist ?? process.env.WEB_DIST ?? DEFAULT_WEB_DIST);
  const keyInfo = o.agent === undefined ? loadApiKey() : { key: null };
  const odConfig = onDemandFromEnv(o.ondemand);
  const redact = redactor(keyInfo.key, odConfig.falKey);
  const rawLog = o.log ?? ((line) => console.log(line));
  const log = (line) => rawLog(redact(line));           // nothing the server logs can contain an API key
  const evalVocab = o.evalVocab ?? process.env.EVAL_VOCAB;
  if (odConfig.wanted && !odConfig.enabled) log(`ondemand off: ${odConfig.reason}`);
  if (odConfig.enabled && evalVocab) { odConfig.enabled = false; odConfig.reason = "EVAL_VOCAB mode"; log("ondemand off: EVAL_VOCAB mode has virtual clips"); }
  if (odConfig.enabled && odConfig.falKey && !process.env.FAL_KEY) process.env.FAL_KEY = odConfig.falKey;   // for pipeline/lib/fal.mjs, this process only
  // Generated clips are one more clip dir, after the configured ones (a configured clip always wins).
  // Production clips (out/realtime/clips-v2-demo|sentences|library, pipeline/produce.mjs) go first: they win over old clips.
  const clipsDirs = [...(o.clipsDirs ?? withV2Clips(parseClipsDirs())), ...(odConfig.enabled ? [odConfig.clipsDir] : [])];
  if (odConfig.enabled) prepareClipsDir(odConfig.clipsDir);

  // The 3D signer's motion library (signs with extracted motion). Off in eval mode (virtual clips).
  const motionCfg = o.motion !== undefined ? o.motion : motionConfig();
  const motions = motionCfg && !evalVocab ? createMotionLibrary(motionCfg) : null;
  if (motions) log(`3d signer: ${motions.size} signs with motion${motions.model ? "" : " (no signer.glb: set SIGNER_MODEL)"}${motions.rest ? "" : " (no rest pose)"}`);

  // Planning vocab + the clip set the playlist builder and the safety gate check against (the real clips, except in eval mode).
  // All three are reloaded when on-demand generation adds clips (reloadClips), so new signs work without a restart.
  // motionSet / motionVocab: the same for clients that can play the 3D signer (clips + signs that only have motion).
  let clips, planClips, vocab, motionSet = null, motionVocab = null;
  const loadClips = () => {
    clips = loadClipSets(clipsDirs);
    planClips = evalVocab ? virtualClips(loadVocab(evalVocab)) : clips;
    vocab = [...planClips.signs.values()].map(({ motion_id, gloss }) => ({ motion_id, gloss }));
    if (motions?.size) {
      motionSet = withMotion(planClips, motions);
      motionVocab = [...motionSet.signs.values()].map(({ motion_id, gloss }) => ({ motion_id, gloss }));
    }
  };
  loadClips();
  clips.warnings.forEach((w) => log(`warning: ${w}`));
  if (evalVocab) log(`EVAL MODE: planning against ${planClips.signs.size} "${evalVocab}" signs with VIRTUAL clips; not for playback`);

  let englishWords = null;
  try { englishWords = loadEnglishWords(); } catch (error) { log(`warning: English word list unavailable (${error.message}); names only by capitalization`); }

  const agent = o.agent !== undefined ? o.agent : agentFromEnv(keyInfo, englishWords, log);
  const transcriber = o.transcriber !== undefined ? o.transcriber : transcriberFromEnv(keyInfo, log);
  const transcribe = createTranscribeHandler(transcriber, { log });
  const composer = o.composer !== undefined ? o.composer : composerFromEnv(keyInfo, log);
  const speaker = o.speaker !== undefined ? o.speaker : speakerFromEnv(keyInfo, log);

  function reloadClips(ids = []) {
    const before = clips.signs.size;
    loadClips();
    extVocab = null;
    log(`clips reloaded: ${before} -> ${clips.signs.size} signs${ids.length ? ` (+${ids.join(" ")})` : ""}`);
  }
  const ondemand = createOnDemand({ ...odConfig, redact, log, hasClip: (id) => clips.signs.has(id), onClipsAdded: reloadClips });
  // Clip vocab + signs that only have motion: used (rules only) to find the words on-demand generation could cover.
  let extVocab = null, extVersion = -1;
  const extendedVocab = () => {
    if (!extVocab || extVersion !== ondemand.version) {
      extVersion = ondemand.version;
      extVocab = [...vocab, ...ondemand.motionVocab().filter((m) => !planClips.signs.has(m.motion_id))];
    }
    return extVocab;
  };
  /** 3D mode: the phrase plays on the 3D signer now; signs it had no clip for are made photoreal for next time. */
  function generateFor3d(playlist) {
    if (!ondemand.enabled) return [];
    try {
      ondemand.rescan();
      return ondemand.request(playlist.filter((p) => !p.url && ondemand.has(p.motion_id)).map((p) => ({ motion_id: p.motion_id })));
    } catch (error) {
      log(`ondemand: request failed: ${error.message}`);
      return [];
    }
  }
  /** Signs the sentence needs that have motion but no clip yet: queue them; the response says which are generating. */
  function generateMissing(text, chosen, trace, opts) {
    if (!ondemand.enabled || chosen.safety.status === "fully_supported") return [];
    try {
      ondemand.rescan();
      const covered = new Set(chosen.plan.items.filter((i) => i.type === "sign" && i.match?.method !== "semantic").map((i) => i.source_index));
      const wanted = translateRules(text, extendedVocab(), opts).items
        .filter((i) => i.type === "sign" && !clips.signs.has(i.motion_id) && ondemand.has(i.motion_id) && !covered.has(i.source_index));
      for (const r of trace?.rejected ?? []) if (r.reason === "not_in_vocab" && ondemand.has(r.id)) wanted.push({ motion_id: r.id });
      return ondemand.request(wanted);
    } catch (error) {
      log(`ondemand: request failed: ${error.message}`);
      return [];
    }
  }

  const semanticWanted = o.semantic ?? process.env.SEMANTIC !== "0";
  const state = { semantic: semanticWanted ? "loading" : "off", warm_ms: null, agent: agent ? "ready" : "off", semantic_motion: "off" };
  const matcher = semanticWanted ? (o.matcher ?? createNodeMatcher()) : null;
  const ready = !matcher ? Promise.resolve(false) : (async () => {
    const t0 = performance.now();
    try {
      // Loads the model and embeds the vocab once ("exhausted" is a leftover word, so the semantic layer runs).
      const plan = await translate("exhausted", vocab, { matcher, englishWords: englishWords ?? undefined });
      const ok = Boolean(matcher.extractor) && plan.translator.semantic !== false;
      state.semantic = ok ? "ready" : "off";
      state.warm_ms = Math.round(performance.now() - t0);
      log(ok ? `semantic model ready (${state.warm_ms} ms)` : `semantic model unavailable (${matcher.failed ?? "unknown"}); rules only`);
      return ok;
    } catch (error) {
      state.semantic = "off";
      log(`semantic model failed (${error.message}); rules only`);
      return false;
    }
  })();
  // The 3D vocab (~1,800 more glosses) is embedded once in the background, after the clip vocab (disk-cached by translate/).
  const motionReady = ready.then(async (ok) => {
    if (!ok || !motionVocab) return false;
    state.semantic_motion = "loading";
    const t0 = performance.now();
    try {
      await translate("exhausted", motionVocab, { matcher, englishWords: englishWords ?? undefined });
      state.semantic_motion = "ready";
      log(`semantic model ready for the 3d vocab (${Math.round(performance.now() - t0)} ms)`);
      return true;
    } catch (error) {
      state.semantic_motion = "off";
      log(`semantic 3d vocab failed (${error.message}); rules only for 3d-only signs`);
      return false;
    }
  });

  /** One playlist builder + safety gate for every translator: a blocked plan never returns a playable prefix
   *  (strict mode). SIGNING_MODE=relaxed keeps whatever valid signs a plan has: partial sentences sign what they can
   *  and agent paraphrases play without confirmation. A malformed plan stays blocked in both modes. */
  function finish(text, plan, set = planClips) {
    const out = planToPlaylist(plan, set);
    const safety = assessSigning(text, plan, set);
    const invalid = safety.reasons?.some((r) => r.code === "invalid_plan");
    if (safety.status !== "fully_supported" && !(RELAXED && !invalid && out.playlist.length)) {
      out.playlist = [];
      out.markers = [];
    }
    return { out, safety, plan };
  }

  async function sign(body) {
    const t0 = performance.now();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "bad_request", "body must be a JSON object {text, semantic?, agent?}");
    const { text, semantic = true, agent: mode = "auto", motion = false } = body;
    if (typeof text !== "string") throw new HttpError(400, "bad_text", "text must be a string");
    if (!text.trim()) throw new HttpError(400, "empty_text", "text is empty");
    if (text.length > MAX_TEXT) throw new HttpError(413, "text_too_long", `text is ${text.length} characters; the limit is ${MAX_TEXT}`);
    if (typeof semantic !== "boolean") throw new HttpError(400, "bad_semantic", "semantic must be a boolean");
    if (!AGENT_MODES.includes(mode)) throw new HttpError(400, "bad_agent", `agent must be one of ${AGENT_MODES.join(", ")}`);
    if (typeof motion !== "boolean") throw new HttpError(400, "bad_motion", "motion must be a boolean");
    const opts = { englishWords: englishWords ?? undefined };
    // motion: the client plays the 3D signer, so signs with motion but no clip are signable (same safety gate).
    const set = motion && motionSet ? motionSet : planClips;
    const planVocab = set === planClips ? vocab : motionVocab;
    const semReady = semantic && state.semantic === "ready";
    const t1 = performance.now();
    const plan = semReady && (set === planClips || state.semantic_motion === "ready")
      ? await translate(text, planVocab, { ...opts, matcher })
      : translateRules(text, planVocab, opts);
    let local = finish(text, plan, set);
    if (set !== planClips && semReady && state.semantic_motion !== "ready" && local.safety.status !== "fully_supported") {
      // The 3D vocab is still being embedded: the clip vocab's semantic plan may still sign it.
      const alt = finish(text, await translate(text, vocab, { ...opts, matcher }), set);
      if (better(alt, local)) local = alt;
    }
    const translate_ms = ms(performance.now() - t1);

    // Hybrid: the local translator answers instantly; the agent is asked only when that is not fully supported
    // (or agent: "always"). Its plan goes through the same gate and wins only if the gate rates it better.
    let chosen = local, translator = "local", trace, agent_ms;
    const warnings = [];
    if (agent && mode !== "off" && (mode === "always" || local.safety.status !== "fully_supported")) {
      const t2 = performance.now();
      let r;
      try { r = await agent.plan(text, vocab, opts); } catch (error) { r = { ok: false, code: "internal", error: redact(error) }; }
      agent_ms = ms(performance.now() - t2);
      if (r.ok) {
        const proposed = finish(text, r.plan, set);
        const wins = mode === "always" || (RELAXED ? signsMore(proposed, local) : better(proposed, local));
        trace = { used: wins, status: proposed.safety.status, local_status: local.safety.status, paraphrase: r.paraphrase, notes: r.notes,
          model: r.model, cached: Boolean(r.cached), latency_ms: r.latency_ms, usage: r.usage ?? null, rejected: r.rejected ?? [] };
        if (wins) trace.local_plan = summarize(local.plan); else trace.plan = summarize(proposed.plan);
        if (r.rejected?.length) log(`agent: rejected ${r.rejected.length} proposed item(s): ${r.rejected.map((x) => `${x.reason}:${x.id ?? x.letters ?? "?"}`).join(", ")}`);
        if (wins) { chosen = proposed; translator = "agent"; }
      } else {
        trace = { used: false, local_status: local.safety.status, model: r.model, code: r.code, error: redact(r.error ?? ""), latency_ms: r.latency_ms };
        warnings.push(`agent unavailable (${r.code}); local translation used`);
        log(`agent failed (${r.code}): ${redact(r.error ?? "")}`);
      }
    }
    const generating = set === planClips ? generateMissing(text, chosen, trace, opts) : generateFor3d(chosen.out.playlist);
    // Relaxed: anything with signs plays. Clients only play "fully_supported", so report that, and keep the strict
    // verdict + reasons (skipped words stay in the captions via `unsupported`).
    let safety = chosen.safety;
    if (RELAXED && chosen.out.playlist.length && safety.status !== "fully_supported") {
      safety = { ...safety, status: "fully_supported", strict_status: safety.status, mode: "relaxed" };
    }
    return {
      text, ...chosen.out, safety, plan: chosen.plan, translator,
      ...(set !== planClips && motions.rest ? { rest_motion_url: motions.rest } : {}),
      ...(translator === "agent" ? { paraphrase: trace.paraphrase } : {}),
      ...(trace ? { agent: trace } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(generating.length ? { generating } : {}),
      ...(evalVocab ? { eval: "virtual_clips" } : {}),
      timings: { translate_ms, ...(agent_ms !== undefined ? { agent_ms } : {}), total_ms: ms(performance.now() - t0) },
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-max-age": "86400" }); return res.end(); }

    if (path === "/api/health") {
      only(req, "GET", "HEAD");
      return json(res, 200, { ok: true, signs: clips.signs.size, semantic: state.semantic, agent: state.agent, transcribe: transcriber ? "ready" : "off", compose: composer ? "ready" : "off", speak: speaker ? "ready" : "off", recognizer: await recognizerStatus(),
        ...(odConfig.wanted || ondemand.enabled ? { ondemand: ondemand.health() } : {}),
        ...(motions ? { motion: { signs: motions.size, model: Boolean(motions.model), semantic: state.semantic_motion } } : {}) });
    }
    if (path === "/api/ondemand") {
      only(req, "GET", "HEAD");
      return json(res, 200, ondemand.status());
    }
    if (path === "/api/vocab") {
      only(req, "GET", "HEAD");
      return json(res, 200, { signs: [...clips.signs.values()].map(({ motion_id, gloss, duration_s }) => ({ motion_id, gloss, duration_s })) });
    }
    if (path === "/api/sign") {
      only(req, "POST");
      return json(res, 200, await sign(await readJson(req)));
    }
    if (path === "/api/sign.mp4") {
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
    if (path === TRANSCRIBE_ROUTE) {
      const r = await transcribe(req, url);
      return json(res, r.status, r.body);
    }
    if (path === COMPOSE_ROUTE) {
      only(req, "POST");
      if (!composer) throw new HttpError(503, "compose_off", "no OpenAI key on the server; compose the sentence on the client");
      let signs, context;
      try { const body = await readJson(req); signs = parseSigns(body); context = parseContext(body); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, "bad_request", e.message); }
      try { return json(res, 200, { ok: true, ...(await composer.compose(signs, context)) }); } catch (e) {
        log(`compose failed: ${redact(e?.message ?? String(e))}`);
        throw new HttpError(502, "compose_failed", "the sentence model did not answer");
      }
    }
    if (path === SPEAK_ROUTE) {
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
    if (path === "/api/recognize") {
      only(req, "POST");
      return recognize(req, res, url);
    }
    if (path === "/api/enroll" || path === "/api/train" || path === "/api/profiles") {
      if (path === "/api/enroll") only(req, "GET", "POST", "DELETE");
      else if (path === "/api/train") only(req, "POST");
      else only(req, "GET");
      return enrollProxy(req, res, url);
    }
    if (path === "/app") { res.writeHead(301, { location: "/app/" + url.search }); return res.end(); }
    if (path.startsWith("/app/")) {
      only(req, "GET", "HEAD");
      return sendWebApp(req, res, path);
    }
    if (path.startsWith("/motion/")) {
      only(req, "GET", "HEAD");
      let stem;
      try { stem = decodeURIComponent(path.slice("/motion/".length)).replace(/\.json$/, ""); } catch { stem = null; }
      const entry = stem && motions ? motions.get(stem) : null;
      if (!entry) throw new HttpError(404, "no_motion", `no motion ${stem ?? path}`);
      return sendMotion(req, res, entry);
    }
    if (path === "/models/signer.glb") {
      only(req, "GET", "HEAD");
      if (!motions?.model) throw new HttpError(404, "no_model", "no 3D signer model on this server (set SIGNER_MODEL or copy puppet/models/signer.glb)");
      return sendFile(req, res, motions.model, { cache: "public, max-age=86400", type: MIME[".glb"] });
    }
    if (path.startsWith("/clips/")) {
      only(req, "GET", "HEAD");
      let rel;
      try { rel = decodeURIComponent(path.slice("/clips/".length)); } catch { rel = null; }
      const file = rel && clips.files.get(rel);
      if (!file) throw new HttpError(404, "no_clip", `no clip ${rel ?? path}`);
      return sendFile(req, res, file);
    }
    if (path === "/" ) return json(res, 200, { name: "flux-server", routes: ["/api/health", "/api/vocab", "/api/ondemand", "POST /api/sign", "/api/sign.mp4?text=", "/clips/<file>", "POST /api/transcribe", "POST /api/recognize?mode=sign|spell", "GET|POST|DELETE /api/enroll", "POST /api/train", "/api/profiles", "POST /api/compose", "POST /api/speak", "/motion/<stem>.json", "/models/signer.glb", "/app/"] });
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
    const text = await upstream.text();
    let out;
    try { out = JSON.parse(text); } catch { throw new HttpError(502, "bad_upstream", "recognizer returned non-JSON"); }
    return json(res, upstream.status, out);
  }

  // "Train my signs": enroll / train / profiles go straight to the recognizer (it owns the reps and the models).
  async function enrollProxy(req, res, url) {
    const q = new URLSearchParams();
    for (const k of ["profile", "label"]) { const v = url.searchParams.get(k); if (v) q.set(k, v.slice(0, 64)); }
    const headers = { "content-type": "application/octet-stream" };
    let body;
    if (req.method === "POST" && url.pathname === "/api/enroll") {
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
    const text = await upstream.text();
    let out;
    try { out = JSON.parse(text); } catch { throw new HttpError(502, "bad_upstream", "recognizer returned non-JSON"); }
    return json(res, upstream.status, out);
  }

  function sendWebApp(req, res, path) {
    const index = join(webDist, "index.html");
    if (!existsSync(index)) throw new HttpError(404, "no_web_build", `web app not built: ${webDist} is missing. Run: cd app/web && npm i && npm run build`);
    let rel;
    try { rel = decodeURIComponent(path.slice("/app/".length)); } catch { throw new HttpError(400, "bad_path", "bad path"); }
    const file = resolve(webDist, rel || "index.html");
    if (file !== webDist && !file.startsWith(webDist + sep)) throw new HttpError(404, "not_found", `no file ${path}`);
    let target = file;
    if (!isFile(target)) {
      // SPA fallback for routes; a missing asset (has an extension) stays a 404 so it is never served as HTML.
      if (extname(rel) && extname(rel) !== ".html") throw new HttpError(404, "not_found", `no file ${path}`);
      target = index;
    }
    const type = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
    const cache = target === index ? "no-cache" : rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600";
    return sendFile(req, res, target, { cache, type });
  }

  function sendJoined(req, res, result) {
    if (!result.playlist.length) throw new HttpError(422, "nothing_to_sign", `nothing in this text has a clip (unsupported: ${result.unsupported.join(", ") || "none"})`);
    const ids = result.playlist.map((p, i) => `${p.motion_id}#${i}`);
    const byId = new Map([...clips.signs.values(), ...clips.letters.values()].map((c) => [c.motion_id, c]));
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

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log(`error: ${error.stack ?? error}`);
      if (res.headersSent) return res.destroy();
      json(res, status, { error: { code: error.code ?? "internal", message: error instanceof HttpError ? error.message : "internal error" } });
    });
  });
  server.on("close", () => ondemand.stop());
  return { server, get clips() { return clips; }, get vocab() { return vocab; }, motions, motionReady, state, ready, sign, agent, transcriber, composer, speaker, ondemand, reloadClips, recognizerUrl, webDist };
}

/** Clip set + motion library -> the set a 3D-capable client can sign: every clip sign (with motion_url when it also has
 *  motion) plus every sign that only has motion (url ""). Same shape as loadClipSets(), so the playlist builder and the
 *  safety gate need no special case. Letters likewise (fingerspelling plays on the 3D signer when every letter has motion). */
export function withMotion(clipSet, motions) {
  const merge = (fromClips, fromMotion) => {
    const out = new Map();
    for (const [k, c] of fromClips) {
      const m = fromMotion.get(k);
      out.set(k, m ? { ...c, motion_url: m.url } : c);
    }
    for (const [k, m] of fromMotion) {
      if (out.has(k)) continue;
      out.set(k, { motion_id: m.motion_id, gloss: m.gloss, url: "", motion_url: m.url, get duration_s() { return m.duration_s; } });
    }
    return out;
  };
  return { ...clipSet, signs: merge(clipSet.signs, motions.signs), letters: merge(clipSet.letters, motions.letters) };
}

/** Slim motion JSON (gzip when the client takes it), cached a day, ETag, CORS like /clips. */
function sendMotion(req, res, entry) {
  const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  const body = gz ? entry.gz : entry.json;
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=86400", etag: entry.etag,
    "last-modified": entry.mtimeDate.toUTCString(), vary: "accept-encoding", "content-length": body.length, ...(gz ? { "content-encoding": "gzip" } : {}) };
  if (req.headers["if-none-match"] === entry.etag) { delete headers["content-length"]; res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

/** On-demand settings: explicit options (tests), null = off, or the environment (never under node --test). */
function onDemandFromEnv(opt) {
  if (opt === null) return { wanted: false, enabled: false, reason: "off" };
  if (opt && typeof opt === "object") return { wanted: true, enabled: true, ...opt };
  if (process.env.NODE_TEST_CONTEXT && process.env.ONDEMAND_IN_TESTS !== "1") return { wanted: false, enabled: false, reason: "tests" };
  const key = loadFalKey();
  return onDemandConfig(process.env, { falKey: key.key, keyError: key.error });
}

const AGENT_MODES = ["auto", "always", "off"];
const RANK = { caption_only: 0, needs_confirmation: 1, fully_supported: 2 };
const RELAXED = (process.env.SIGNING_MODE ?? "strict").toLowerCase() === "relaxed";

/** Relaxed mode: the agent wins if the gate rates it better, or equal but it signs more of the message. */
function signsMore(a, b) {
  const ra = RANK[a.safety.status], rb = RANK[b.safety.status];
  if (ra !== rb) return ra > rb;
  return a.out.playlist.length > b.out.playlist.length;
}

/** Agent result beats local only if the gate rates it strictly better; ties go to the local translator. */
export function better(a, b) {
  const ra = RANK[a.safety.status], rb = RANK[b.safety.status];
  if (ra !== rb) return ra > rb;
  // Both waiting for confirmation: fewer open questions (fewer non-literal signs) is better.
  return ra === RANK.needs_confirmation && a.safety.reasons.length < b.safety.reasons.length;
}

/** "HURT WHERE~" style one-liner of a plan (~ = semantic / paraphrased sign) for the agent trace. */
const summarize = (plan) => plan.items.map((i) => (i.type === "sign" ? i.motion_id : `fs:${i.word}`) + (i.match?.method === "semantic" ? "~" : "")).join(" ");

/** Agent from the environment, or null. Never under node --test (no paid calls from tests) unless AGENT_IN_TESTS=1. */
function agentFromEnv(keyInfo, englishWords, log) {
  if (process.env.AGENT === "off" || process.env.AGENT === "0") return null;
  if (process.env.NODE_TEST_CONTEXT && process.env.AGENT_IN_TESTS !== "1") return null;
  if (!keyInfo.key) { if (keyInfo.error) log(`agent off: ${keyInfo.error}`); return null; }
  let OpenAI;
  try { OpenAI = createRequire(import.meta.url)("openai").OpenAI; } catch {
    log("agent off: the openai package is not installed (cd app/server && npm i)");
    return null;
  }
  const timeoutMs = Number(process.env.AGENT_TIMEOUT_MS) > 0 ? Number(process.env.AGENT_TIMEOUT_MS) : undefined;
  const agent = createAgent({ client: new OpenAI({ apiKey: keyInfo.key, maxRetries: 0 }), secrets: [keyInfo.key], englishWords: englishWords ?? undefined, timeoutMs });
  log(`agent: ${agent.model} (key from ${keyInfo.source === "file" ? "OPENAI_API_KEY_FILE" : "OPENAI_API_KEY"}, timeout ${agent.timeoutMs} ms)`);
  return agent;
}

/** Sentence composer (sign -> voice) from the environment, or null. Never under node --test unless AGENT_IN_TESTS=1. */
function composerFromEnv(keyInfo, log) {
  if (process.env.COMPOSE === "off" || process.env.COMPOSE === "0") return null;
  if (process.env.NODE_TEST_CONTEXT && process.env.AGENT_IN_TESTS !== "1") return null;
  if (!keyInfo.key) return null;
  let OpenAI;
  try { OpenAI = createRequire(import.meta.url)("openai").OpenAI; } catch { return null; }
  const composer = createComposer({ client: new OpenAI({ apiKey: keyInfo.key, maxRetries: 0 }) });
  log(`compose: ${composer.model} (sign -> sentence)`);
  return composer;
}

function cors(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, HEAD, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] ?? "content-type, range");
  res.setHeader("access-control-expose-headers", "content-length, content-range, accept-ranges, x-flux-unsupported");
  // Chrome Private Network Access: lets https pages / the extension reach this server on localhost or the LAN.
  if (req.headers["access-control-request-private-network"]) res.setHeader("access-control-allow-private-network", "true");
}

function only(req, ...methods) {
  if (!methods.includes(req.method)) throw new HttpError(405, "method_not_allowed", `use ${methods.join(" or ")}`);
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), "cache-control": "no-store" });
  res.end(res.req?.method === "HEAD" ? undefined : data);
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const tooLarge = () => new HttpError(413, "too_many_frames", `body over ${limit} bytes (384 frames)`);
    req.on("data", (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      else if (size > 4 * limit) { reject(tooLarge()); req.destroy(); }
    });
    req.on("end", () => (size > limit ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const tooLarge = () => new HttpError(413, "body_too_large", `body over ${MAX_BODY} bytes`);
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
      else if (size > 64 * MAX_BODY) { reject(tooLarge()); req.destroy(); }   // drain small overflows so the 413 reaches the client
    });
    req.on("end", () => {
      if (size > MAX_BODY) return reject(tooLarge());
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return reject(new HttpError(400, "empty_body", "send JSON {text}"));
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, "bad_json", "body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

/** Static file with single-range support (206 / 416), ETag and Last-Modified. */
function sendFile(req, res, file, { cache = "public, max-age=86400", type = "video/mp4" } = {}) {
  const st = statSync(file);
  const size = st.size;
  const etag = `"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    "content-type": type, "accept-ranges": "bytes", "cache-control": cache,
    etag, "last-modified": st.mtime.toUTCString(),
  };
  if (!req.headers.range && req.headers["if-none-match"] === etag) { res.writeHead(304, headers); return res.end(); }
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range && (!req.headers["if-range"] || req.headers["if-range"] === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
      else { start = Math.max(0, size - Number(m[2])); end = size - 1; }
      if (start > end || start >= size) {
        res.writeHead(416, { ...headers, "content-range": `bytes */${size}`, "content-length": 0 });
        return res.end();
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    // Multi-range or malformed: ignore the header and send the whole file (allowed by RFC 9110).
  }
  headers["content-length"] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === "HEAD" || size === 0) return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

export function lanUrls(port) {
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) urls.push(`http://${a.address}:${port}`);
  }
  return urls;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  const app = createApp();
  app.server.listen(port, "0.0.0.0", () => {
    console.log(`Flux server: ${app.clips.signs.size} signs from ${app.clips.dirs.map((d) => `${d.dir} (${d.signs})`).join(", ")}`);
    for (const u of lanUrls(port)) console.log(`  ${u}`);
    console.log(`semantic: ${app.state.semantic}`);
    console.log(`agent: ${app.state.agent}${app.agent?.model ? ` (${app.agent.model})` : ""}`);
    console.log(`ondemand: ${app.ondemand.enabled ? `on (${app.ondemand.clipsDir})` : "off"}`);
    console.log(`transcribe: ${app.transcriber?.model ?? "off"}`);
    console.log(`speak: ${app.speaker ? `${app.speaker.model} (${app.speaker.voice})` : "off"}`);
    console.log(`recognizer: ${app.recognizerUrl}`);
    console.log(`web app: ${existsSync(join(app.webDist, "index.html")) ? `${lanUrls(port).at(-1)}/app/` : `not built (${app.webDist})`}`);
  });
  app.server.on("error", (error) => { console.error(error.message); process.exit(1); });
}
