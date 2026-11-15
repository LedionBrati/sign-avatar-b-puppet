// API key loading + redaction. Keys are read once at startup and never logged, echoed or returned.
//
//   OPENAI_API_KEY=sk-...                 key in the environment (agent layer)
//   OPENAI_API_KEY_FILE=C:/path/key.txt   or a file holding it (read + trimmed at startup)
//   FAL_KEY / FAL_KEY_FILE                same, for the on-demand clip generator (lib/ondemand.mjs)

import { readFileSync } from "node:fs";

/** Shapes of OpenAI-style secrets, redacted even if they are not the configured key (e.g. echoed by an upstream error). */
const KEY_SHAPES = /\b(?:sk|rk|sess)-[A-Za-z0-9_-]{8,}/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ key: string, source: "env" | "file" } | { key: null, source: "none" | "file", error?: string }}
 * Errors name the file path only, never its content.
 */
export function loadApiKey(env = process.env) {
  return loadKey(env, "OPENAI_API_KEY");
}

/** fal key for the on-demand clip generator (lib/ondemand.mjs): FAL_KEY, else FAL_KEY_FILE. Same rules as loadApiKey. */
export function loadFalKey(env = process.env) {
  return loadKey(env, "FAL_KEY");
}

function loadKey(env, name) {
  const direct = env[name]?.trim();
  if (direct) return { key: direct, source: "env" };
  const file = env[`${name}_FILE`]?.trim();
  if (!file) return { key: null, source: "none" };
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch (error) {
    return { key: null, source: "file", error: `cannot read ${name}_FILE (${file}): ${error.code ?? "read error"}` };
  }
  // First non-empty line, so a trailing newline or a comment line after the key does not break it.
  const key = raw.replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  if (!key) return { key: null, source: "file", error: `${name}_FILE (${file}) is empty` };
  return { key, source: "file" };
}

/** (text) => text with the given secrets and anything key-shaped replaced by "[redacted]". */
export function redactor(...secrets) {
  const exact = secrets.filter((s) => typeof s === "string" && s.length >= 8);
  return (value) => {
    let s = typeof value === "string" ? value : value instanceof Error ? `${value.name}: ${value.message}` : String(value);
    for (const secret of exact) s = s.split(secret).join("[redacted]");
    return s.replace(KEY_SHAPES, "[redacted]").replace(BEARER, "$1[redacted]");
  };
}
