// Static responses: files with Range (clips, the joined mp4, the signer model), the built web app with SPA fallback,
// and slim motion JSON for the 3D signer.

import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { HttpError } from "./http.mjs";

export const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".wasm": "application/wasm", ".task": "application/octet-stream",
  ".tflite": "application/octet-stream", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
  ".glb": "model/gltf-binary",
};

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Static file with single-range support (206 / 416), ETag and Last-Modified. */
export function sendFile(req, res, file, { cache = "public, max-age=86400", type = "video/mp4" } = {}) {
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

/** GET /app/*: the built web app in webDist, SPA fallback to index.html. */
export function sendWebApp(req, res, path, webDist) {
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

/** Slim motion JSON (gzip when the client takes it), cached a day, ETag, CORS like /clips. */
export function sendMotion(req, res, entry) {
  const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  const body = gz ? entry.gz : entry.json;
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=86400", etag: entry.etag,
    "last-modified": entry.mtimeDate.toUTCString(), vary: "accept-encoding", "content-length": body.length, ...(gz ? { "content-encoding": "gzip" } : {}) };
  if (req.headers["if-none-match"] === entry.etag) { delete headers["content-length"]; res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}
