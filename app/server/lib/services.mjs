// The optional services, built from the environment unless createApp() was given them (tests pass fakes or null):
// the OpenAI layer (agent, compose, transcribe, speak: one key) and generate-on-use (fal). Keys come from
// lib/secrets.mjs and are never logged; none of this starts under node --test (lib/config.mjs).

import { createRequire } from "node:module";
import { createAgent } from "./agent.mjs";
import { createComposer } from "./compose.mjs";
import { onDemandConfig } from "./config.mjs";
import { loadFalKey } from "./secrets.mjs";
import { speakerFromEnv } from "./speak.mjs";
import { transcriberFromEnv } from "./transcribe.mjs";

const openAi = () => createRequire(import.meta.url)("openai").OpenAI;

/** {agent, transcriber, composer, speaker}: each from o if given there (null = off), else from the key + environment. */
export function openAiServices(o, cfg, keyInfo, englishWords, log) {
  const agent = o.agent !== undefined ? o.agent : agentFromEnv(cfg, keyInfo, englishWords, log);
  const transcriber = o.transcriber !== undefined ? o.transcriber : transcriberFromEnv(keyInfo, log);
  const composer = o.composer !== undefined ? o.composer : composerFromEnv(cfg, keyInfo, log);
  const speaker = o.speaker !== undefined ? o.speaker : speakerFromEnv(keyInfo, log);
  return { agent, transcriber, composer, speaker };
}

/** Agent from the environment, or null. Never under node --test (no paid calls from tests) unless AGENT_IN_TESTS=1. */
function agentFromEnv(cfg, keyInfo, englishWords, log) {
  if (cfg.agentOff || !cfg.openAiInTests) return null;
  if (!keyInfo.key) { if (keyInfo.error) log(`agent off: ${keyInfo.error}`); return null; }
  let OpenAI;
  try { OpenAI = openAi(); } catch {
    log("agent off: the openai package is not installed (cd app/server && npm i)");
    return null;
  }
  const agent = createAgent({ client: new OpenAI({ apiKey: keyInfo.key, maxRetries: 0 }), secrets: [keyInfo.key], englishWords: englishWords ?? undefined, timeoutMs: cfg.agentTimeoutMs });
  log(`agent: ${agent.model} (key from ${keyInfo.source === "file" ? "OPENAI_API_KEY_FILE" : "OPENAI_API_KEY"}, timeout ${agent.timeoutMs} ms)`);
  return agent;
}

/** Sentence composer (sign -> voice) from the environment, or null. Never under node --test unless AGENT_IN_TESTS=1. */
function composerFromEnv(cfg, keyInfo, log) {
  if (cfg.composeOff || !cfg.openAiInTests) return null;
  if (!keyInfo.key) return null;
  let OpenAI;
  try { OpenAI = openAi(); } catch { return null; }
  const composer = createComposer({ client: new OpenAI({ apiKey: keyInfo.key, maxRetries: 0 }) });
  log(`compose: ${composer.model} (sign -> sentence)`);
  return composer;
}

/** On-demand settings: explicit options (tests), null = off, or the environment (never under node --test). */
export function onDemandFromEnv(opt, cfg, env = process.env) {
  if (opt === null) return { wanted: false, enabled: false, reason: "off" };
  if (opt && typeof opt === "object") return { wanted: true, enabled: true, ...opt };
  if (!cfg.ondemandInTests) return { wanted: false, enabled: false, reason: "tests" };
  const key = loadFalKey(env);
  return onDemandConfig(env, { falKey: key.key, keyError: key.error });
}
