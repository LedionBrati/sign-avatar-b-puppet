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
//
//   Every environment variable, with its default: lib/config.mjs. Modules: lib/config.mjs (env), lib/services.mjs
//   (OpenAI + fal services), lib/sign-pipeline.mjs (clip library, translators, safety gate), lib/routes.mjs (router,
//   recognizer proxy, joined mp4), lib/static.mjs (files, web app, motion), lib/http.mjs (errors, bodies, CORS).

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createNodeMatcher } from "../../translate/node.mjs";
import { parseClipsDirs, withV2Clips } from "./lib/clips.mjs";
import { motionConfig, serverConfig } from "./lib/config.mjs";
import { HttpError, json } from "./lib/http.mjs";
import { createMotionLibrary } from "./lib/motions.mjs";
import { createOnDemand, prepareClipsDir } from "./lib/ondemand.mjs";
import { createRouter } from "./lib/routes.mjs";
import { loadApiKey, redactor } from "./lib/secrets.mjs";
import { onDemandFromEnv, openAiServices } from "./lib/services.mjs";
import { createClipLibrary, createSignPipeline, englishWordsOrNull } from "./lib/sign-pipeline.mjs";
import { createTranscribeHandler } from "./lib/transcribe.mjs";

export { MAX_RECOGNIZE_BODY } from "./lib/routes.mjs";
export { MAX_TEXT, better, withMotion } from "./lib/sign-pipeline.mjs";

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
  const cfg = serverConfig(o);
  const { evalVocab } = cfg;
  const keyInfo = o.agent === undefined ? loadApiKey() : { key: null };
  const odConfig = onDemandFromEnv(o.ondemand, cfg);
  const redact = redactor(keyInfo.key, odConfig.falKey);
  const rawLog = o.log ?? ((line) => console.log(line));
  const log = (line) => rawLog(redact(line));           // nothing the server logs can contain an API key
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

  const lib = createClipLibrary({ clipsDirs, evalVocab, motions, log });
  const englishWords = englishWordsOrNull(log);
  const { agent, transcriber, composer, speaker } = openAiServices(o, cfg, keyInfo, englishWords, log);
  const transcribe = createTranscribeHandler(transcriber, { log });
  const ondemand = createOnDemand({ ...odConfig, redact, log, hasClip: (id) => lib.clips.signs.has(id), onClipsAdded: lib.reload });

  const matcher = cfg.semantic ? (o.matcher ?? createNodeMatcher()) : null;
  const pipeline = createSignPipeline({ lib, motions, ondemand, agent, matcher, englishWords, relaxed: cfg.relaxed, evalVocab, redact, log });
  const handle = createRouter({ cfg, lib, pipeline, motions, ondemand, ondemandWanted: odConfig.wanted, transcribe, transcriber, composer, speaker, redact, log });

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log(`error: ${error.stack ?? error}`);
      if (res.headersSent) return res.destroy();
      json(res, status, { error: { code: error.code ?? "internal", message: error instanceof HttpError ? error.message : "internal error" } });
    });
  });
  server.on("close", () => ondemand.stop());
  const { sign, state, ready, motionReady } = pipeline;
  return { server, get clips() { return lib.clips; }, get vocab() { return lib.vocab; }, motions, motionReady, state, ready, sign, agent, transcriber, composer, speaker, ondemand,
    reloadClips: lib.reload, recognizerUrl: cfg.recognizerUrl, webDist: cfg.webDist };
}

export function lanUrls(port) {
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) urls.push(`http://${a.address}:${port}`);
  }
  return urls;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = serverConfig();
  const app = createApp();
  app.server.listen(port, "0.0.0.0", () => {
    const urls = lanUrls(port);
    console.log(`Flux server: ${app.clips.signs.size} signs from ${app.clips.dirs.map((d) => `${d.dir} (${d.signs})`).join(", ")}`);
    for (const u of urls) console.log(`  ${u}`);
    console.log(`semantic: ${app.state.semantic}`);
    console.log(`agent: ${app.state.agent}${app.agent?.model ? ` (${app.agent.model})` : ""}`);
    console.log(`ondemand: ${app.ondemand.enabled ? `on (${app.ondemand.clipsDir})` : "off"}`);
    console.log(`transcribe: ${app.transcriber?.model ?? "off"}`);
    console.log(`speak: ${app.speaker ? `${app.speaker.model} (${app.speaker.voice})` : "off"}`);
    console.log(`recognizer: ${app.recognizerUrl}`);
    console.log(`web app: ${existsSync(join(app.webDist, "index.html")) ? `${urls.at(-1)}/app/` : `not built (${app.webDist})`}`);
  });
  app.server.on("error", (error) => { console.error(error.message); process.exit(1); });
}
