// Small node:http helpers: JSON errors, CORS, method guards, bounded body readers.

import { MAX_FRAMES } from "../../core/src/landmarks.ts";

export const MAX_BODY = 16 * 1024;

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function cors(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, HEAD, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] ?? "content-type, range");
  res.setHeader("access-control-expose-headers", "content-length, content-range, accept-ranges, x-flux-unsupported");
  // Chrome Private Network Access: lets https pages / the extension reach this server on localhost or the LAN.
  if (req.headers["access-control-request-private-network"]) res.setHeader("access-control-allow-private-network", "true");
}

export function only(req, ...methods) {
  if (!methods.includes(req.method)) throw new HttpError(405, "method_not_allowed", `use ${methods.join(" or ")}`);
}

export function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), "cache-control": "no-store" });
  res.end(res.req?.method === "HEAD" ? undefined : data);
}

export function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const tooLarge = () => new HttpError(413, "too_many_frames", `body over ${limit} bytes (${MAX_FRAMES} frames)`);
    req.on("data", (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      else if (size > 4 * limit) { reject(tooLarge()); req.destroy(); }
    });
    req.on("end", () => (size > limit ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

export function readJson(req) {
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
