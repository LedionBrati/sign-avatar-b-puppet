// Every environment variable the server reads, with its default. createApp() options override them (tests).
// Relative default paths are relative to the repo root (lib/paths.mjs).
//
//   PORT=8787  HOST=127.0.0.1           listen address; HOST=0.0.0.0 makes the server reachable from phones on the LAN
//   RECOGNIZER_URL=http://127.0.0.1:8788   app/recognizer (sign -> voice)
//   WEB_DIST=app/web/dist               the built web app served at /app/
//   CLIPS_DIR=out/realtime/clips        clip dirs, comma separated (lib/clips.mjs); CLIPS_V2=0: no clips-v2-* in front
//   SEMANTIC=0                          rules only (no local embedding model)
//   SIGNING_MODE=strict | relaxed       relaxed: partial sentences sign what they can
//   EVAL_VOCAB=dictionary               DEV ONLY: plan against the SIGN_DICTIONARY signs with virtual clips
//   OPENAI_API_KEY | OPENAI_API_KEY_FILE    one key for the agent, compose, transcribe and speak (lib/secrets.mjs)
//     AGENT=off  OPENAI_MODEL=gpt-5.4-mini  AGENT_TIMEOUT_MS=6000  AGENT_REASONING=none   (lib/agent.mjs)
//     COMPOSE=off  COMPOSE_MODEL=gpt-5.4-mini                                          (lib/compose.mjs)
//     TRANSCRIBE=off  TRANSCRIBE_MODEL=gpt-4o-mini-transcribe                          (lib/transcribe.mjs)
//     SPEAK=off  SPEAK_MODEL=gpt-4o-mini-tts  SPEAK_VOICE=coral                        (lib/speak.mjs)
//   MOTION=off  MOTION_DIRS=out/motion/wlasl  MOTION_V2_DIRS=out/motion/wlasl3d  MOTION_REST=out/realtime/neutral.clean.json
//     SIGNER_MODEL=puppet/models/signer.glb  MOTION_MIN_HAND_PCT=80                    the 3D signer (motionConfig)
//   ONDEMAND=on  FAL_KEY | FAL_KEY_FILE  FAL_DAILY_BUDGET_USD=20  ONDEMAND_MAX_QUEUE=30  ONDEMAND_MIN_HAND_PCT=80
//     ONDEMAND_NEUTRAL=out/realtime/neutral.clean.json  ONDEMAND_AVATAR=assets/avatar/avatar-main.jpg
//     PUPPET_RENDER=puppet/render.mjs  ONDEMAND_STATE_DIR=out/ondemand  ONDEMAND_CLIPS_DIR=out/realtime/clips-ondemand
//                                       generate-on-use (onDemandConfig; also needs MOTION_DIRS, ffmpeg + ffprobe)
//   SIGN_CLIPS_DIR, SIGN_DICTIONARY     translate/node.mjs (the EVAL_VOCAB dictionary)
//   Under node --test nothing paid or slow starts from the environment; AGENT_IN_TESTS=1 (OpenAI services),
//   ONDEMAND_IN_TESTS=1 and MOTION_IN_TESTS=1 opt back in.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PORT } from "../../core/src/api.ts";
import { fromRepo, list } from "./paths.mjs";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_RECOGNIZER_URL = "http://127.0.0.1:8788";
const offSwitch = (v) => v === "off" || v === "0";

/** Server-level settings (createApp options win over the environment). */
export function serverConfig(o = {}, env = process.env) {
  return {
    port: Number(env.PORT ?? DEFAULT_PORT),
    host: env.HOST || DEFAULT_HOST,
    recognizerUrl: (o.recognizerUrl ?? env.RECOGNIZER_URL ?? DEFAULT_RECOGNIZER_URL).replace(/\/+$/, ""),
    webDist: resolve(o.webDist ?? env.WEB_DIST ?? fromRepo("app/web/dist")),
    evalVocab: o.evalVocab ?? env.EVAL_VOCAB,
    semantic: o.semantic ?? env.SEMANTIC !== "0",
    relaxed: (env.SIGNING_MODE ?? "strict").toLowerCase() === "relaxed",
    agentOff: offSwitch(env.AGENT),
    agentTimeoutMs: Number(env.AGENT_TIMEOUT_MS) > 0 ? Number(env.AGENT_TIMEOUT_MS) : undefined,
    composeOff: offSwitch(env.COMPOSE),
    /** No paid OpenAI calls from tests. */
    openAiInTests: !(env.NODE_TEST_CONTEXT && env.AGENT_IN_TESTS !== "1"),
    ondemandInTests: !(env.NODE_TEST_CONTEXT && env.ONDEMAND_IN_TESTS !== "1"),
  };
}

const ifExists = (p) => (existsSync(p) ? p : null);

/** 3D signer settings (lib/motions.mjs createMotionLibrary), null = off. Never under node --test unless MOTION_IN_TESTS=1. */
export function motionConfig(env = process.env) {
  if (/^(off|0|false|no)$/i.test(env.MOTION ?? "")) return null;
  if (env.NODE_TEST_CONTEXT && env.MOTION_IN_TESTS !== "1") return null;
  const v1 = list(env.MOTION_DIRS);
  const v2 = list(env.MOTION_V2_DIRS);
  return {
    dirs: v1.length ? v1 : [fromRepo("out/motion/wlasl")],
    v2Dirs: v2.length ? v2 : [fromRepo("out/motion/wlasl3d")],
    rest: env.MOTION_REST || ifExists(fromRepo("out/realtime/neutral.clean.json")),
    model: env.SIGNER_MODEL || ifExists(fromRepo("puppet/models/signer.glb")),
    minHandPct: Number.isFinite(Number(env.MOTION_MIN_HAND_PCT)) && env.MOTION_MIN_HAND_PCT ? Number(env.MOTION_MIN_HAND_PCT) : 80,
  };
}

/**
 * Generate-on-use settings (lib/ondemand.mjs createOnDemand). Enabled only with ONDEMAND=on, a fal key and at least
 * one motion dir. @returns {{wanted: boolean, enabled: boolean, reason?: string, ...options}}
 */
export function onDemandConfig(env = process.env, { falKey = null, keyError } = {}) {
  const wanted = env.ONDEMAND !== undefined && env.ONDEMAND !== "";
  const on = /^(on|1|true|yes)$/i.test(env.ONDEMAND ?? "");
  const motionDirs = list(env.MOTION_DIRS);
  const cfg = {
    wanted,
    motionDirs,
    neutral: env.ONDEMAND_NEUTRAL || fromRepo("out/realtime/neutral.clean.json"),
    avatar: env.ONDEMAND_AVATAR || fromRepo("assets/avatar/avatar-main.jpg"),
    renderScript: env.PUPPET_RENDER || fromRepo("puppet/render.mjs"),
    stateDir: env.ONDEMAND_STATE_DIR || fromRepo("out/ondemand"),
    clipsDir: env.ONDEMAND_CLIPS_DIR || fromRepo("out/realtime/clips-ondemand"),
    budgetUsd: Number(env.FAL_DAILY_BUDGET_USD) >= 0 && env.FAL_DAILY_BUDGET_USD !== undefined && env.FAL_DAILY_BUDGET_USD !== "" ? Number(env.FAL_DAILY_BUDGET_USD) : 20,
    maxQueue: Number(env.ONDEMAND_MAX_QUEUE) > 0 ? Math.floor(Number(env.ONDEMAND_MAX_QUEUE)) : 30,
    minHandPct: Number.isFinite(Number(env.ONDEMAND_MIN_HAND_PCT)) && env.ONDEMAND_MIN_HAND_PCT ? Number(env.ONDEMAND_MIN_HAND_PCT) : 80,
    falKey,
  };
  const reason = !on ? (wanted ? `ONDEMAND=${env.ONDEMAND} (set ONDEMAND=on)` : "ONDEMAND is not on")
    : !falKey ? (keyError ?? "no fal key (set FAL_KEY_FILE or FAL_KEY)")
    : !motionDirs.length ? "MOTION_DIRS is not set"
    : null;
  return { ...cfg, enabled: !reason, ...(reason ? { reason } : {}) };
}

