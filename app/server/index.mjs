// SIGNLAYER local API (contract: app/core/src/api.ts). Plain node:http, no framework.
//
//   node app/server/index.mjs            PORT=8787, CLIPS_DIR=dir[,dir2,...], SEMANTIC=0 to disable embeddings
//
//   GET  /api/health          {ok, signs, semantic: "ready" | "loading" | "off"}
//   GET  /api/vocab           {signs: [{motion_id, gloss, duration_s}]}
//   POST /api/sign            {text, semantic?} -> words, playlist, unsupported, fingerspell, markers, plan, timings
//   GET  /api/sign.mp4?text=  the playlist joined into one mp4 (ffmpeg stream copy), for sharing / download
//   GET  /clips/<file>        clips from the manifests, with HTTP Range (206) for Safari / iOS / expo-video

import { createServer } from "node:http";
import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { translate, translateRules } from "../../translate/index.mjs";
import { createNodeMatcher, loadEnglishWords } from "../../translate/node.mjs";
import { joinClips } from "../../pipeline/lib/clips.mjs";
import { loadClipSets, parseClipsDirs } from "./lib/clips.mjs";
import { planToPlaylist } from "./lib/sign.mjs";

export const MAX_TEXT = 500;
const MAX_BODY = 16 * 1024;
const ms = (x) => Math.round(x * 100) / 100;

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/**
 * @param {object} [o]
 * @param {string[]} [o.clipsDirs]  default: CLIPS_DIR env (comma-separated) or the puppet repo's out/realtime/clips
 * @param {boolean} [o.semantic]    default: SEMANTIC env != "0"; warms the local model in the background
 * @param {object} [o.matcher]      SemanticMatcher override (tests)
 * @param {(line: string) => void} [o.log]
 */
export function createApp(o = {}) {
  const clips = loadClipSets(o.clipsDirs ?? parseClipsDirs());
  const vocab = [...clips.signs.values()].map(({ motion_id, gloss }) => ({ motion_id, gloss }));
  const log = o.log ?? ((line) => console.log(line));
  clips.warnings.forEach((w) => log(`warning: ${w}`));

  let englishWords = null;
  try { englishWords = loadEnglishWords(); } catch (error) { log(`warning: English word list unavailable (${error.message}); names only by capitalization`); }

  const semanticWanted = o.semantic ?? process.env.SEMANTIC !== "0";
  const state = { semantic: semanticWanted ? "loading" : "off", warm_ms: null };
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

  async function sign(body) {
    const t0 = performance.now();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "bad_request", "body must be a JSON object {text, semantic?}");
    const { text, semantic = true } = body;
    if (typeof text !== "string") throw new HttpError(400, "bad_text", "text must be a string");
    if (!text.trim()) throw new HttpError(400, "empty_text", "text is empty");
    if (text.length > MAX_TEXT) throw new HttpError(413, "text_too_long", `text is ${text.length} characters; the limit is ${MAX_TEXT}`);
    if (typeof semantic !== "boolean") throw new HttpError(400, "bad_semantic", "semantic must be a boolean");
    const opts = { englishWords: englishWords ?? undefined };
    const t1 = performance.now();
    const plan = semantic && state.semantic === "ready"
      ? await translate(text, vocab, { ...opts, matcher })
      : translateRules(text, vocab, opts);
    const translate_ms = ms(performance.now() - t1);
    const out = planToPlaylist(plan, clips);
    return { text, ...out, plan, timings: { translate_ms, total_ms: ms(performance.now() - t0) } };
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-max-age": "86400" }); return res.end(); }

    if (path === "/api/health") {
      only(req, "GET", "HEAD");
      return json(res, 200, { ok: true, signs: clips.signs.size, semantic: state.semantic });
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
      const result = await sign({ text: url.searchParams.get("text") ?? "", semantic: url.searchParams.get("semantic") !== "false" });
      return sendJoined(req, res, result);
    }
    if (path.startsWith("/clips/")) {
      only(req, "GET", "HEAD");
      let rel;
      try { rel = decodeURIComponent(path.slice("/clips/".length)); } catch { rel = null; }
      const file = rel && clips.files.get(rel);
      if (!file) throw new HttpError(404, "no_clip", `no clip ${rel ?? path}`);
      return sendFile(req, res, file);
    }
    if (path === "/" ) return json(res, 200, { name: "signlayer-server", routes: ["/api/health", "/api/vocab", "POST /api/sign", "/api/sign.mp4?text=", "/clips/<file>"] });
    throw new HttpError(404, "not_found", `no route ${req.method} ${path}`);
  }

  function sendJoined(req, res, result) {
    if (!result.playlist.length) throw new HttpError(422, "nothing_to_sign", `nothing in this text has a clip (unsupported: ${result.unsupported.join(", ") || "none"})`);
    const ids = result.playlist.map((p, i) => `${p.motion_id}#${i}`);
    const byId = new Map([...clips.signs.values(), ...clips.letters.values()].map((c) => [c.motion_id, c]));
    const manifest = Object.fromEntries(result.playlist.map((p, i) => [ids[i], { file: byId.get(p.motion_id).path, seconds: p.duration_s }]));
    const dir = mkdtempSync(join(tmpdir(), "signlayer-"));
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
    res.setHeader("x-signlayer-unsupported", encodeURIComponent(result.unsupported.join(" ")));
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
  return { server, clips, vocab, state, ready, sign };
}

function cors(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] ?? "content-type, range");
  res.setHeader("access-control-expose-headers", "content-length, content-range, accept-ranges, x-signlayer-unsupported");
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
function sendFile(req, res, file, { cache = "public, max-age=86400" } = {}) {
  const st = statSync(file);
  const size = st.size;
  const etag = `"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": cache,
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
    console.log(`SIGNLAYER server: ${app.clips.signs.size} signs from ${app.clips.dirs.map((d) => `${d.dir} (${d.signs})`).join(", ")}`);
    for (const u of lanUrls(port)) console.log(`  ${u}`);
    console.log(`semantic: ${app.state.semantic}`);
  });
  app.server.on("error", (error) => { console.error(error.message); process.exit(1); });
}
