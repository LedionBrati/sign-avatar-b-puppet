// Local test server for the Lucy realtime experiment.
//
// - Serves the test page (index.html, app.js, dist/app.bundle.js).
// - POST /token  -> short-lived fal realtime JWT for a Lucy app (the fal key never leaves this process).
// - GET  /media/<name>  -> the puppet clips and the avatar (paths from env, see below).
// - POST /save?name=<file>  -> writes the request body into ./out/ (recorded output, metrics JSON).
//
// Env:
//   FAL_KEY_FILE   path to a file holding the fal key (read + trimmed once at startup, never logged)
//   PORT           default 8799
//   MEDIA_JUDY, MEDIA_SENTENCE, MEDIA_AVATAR  optional overrides for the media files
//                  (defaults: <repo>/out/puppet/judy-vrm.mp4, <repo>/out/sentences/thank-you-see-you-later-vrm.mp4,
//                  assets/avatar/avatar-main.jpg)
//
// Usage: FAL_KEY_FILE=<path-to>/fal-key.txt node token-server.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const PORT = Number(process.env.PORT || 8799);

let FAL_KEY = "";
try {
  FAL_KEY = fs.readFileSync(process.env.FAL_KEY_FILE || "", "utf8").trim();
} catch {
  // fall through
}
if (!FAL_KEY) {
  console.error("FAL_KEY_FILE missing or empty; /token will fail.");
}

// Anything that might echo the key back gets scrubbed before it is logged or returned.
const redact = (s) => (FAL_KEY ? String(s).split(FAL_KEY).join("[REDACTED]") : String(s));

const MEDIA = {
  "judy.mp4": process.env.MEDIA_JUDY || path.join(repo, "out/puppet/judy-vrm.mp4"),
  "sentence.mp4": process.env.MEDIA_SENTENCE || path.join(repo, "out/sentences/thank-you-see-you-later-vrm.mp4"),
  "avatar.jpg": process.env.MEDIA_AVATAR || path.join(repo, "assets/avatar/avatar-main.jpg"),
  "avatar-hands-down.jpg": path.join(repo, "assets/avatar/avatar-hands-down.jpg"),
};

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.bundle.js": ["dist/app.bundle.js", "text/javascript; charset=utf-8"],
};

const ALLOWED_APPS = new Set(["lucy-2-6", "lucy-2-5", "lucy-2"]);
const outDir = path.join(here, "out");

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function mintToken(appField) {
  // The client sends the token scope, e.g. "decart/lucy-2-6/realtime". fal wants the alias.
  const parts = String(appField || "").split("/");
  const alias = parts.length >= 2 ? parts[1] : parts[0];
  if (!ALLOWED_APPS.has(alias)) throw new Error(`app not allowed: ${alias}`);
  const r = await fetch("https://rest.fal.ai/tokens/", {
    method: "POST",
    headers: { authorization: `Key ${FAL_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ allowed_apps: [alias], token_expiration: 120 }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`fal /tokens ${r.status}: ${redact(text).slice(0, 300)}`);
  let token = JSON.parse(text);
  if (typeof token !== "string" && token && token.detail) token = token.detail;
  if (typeof token !== "string") throw new Error("unexpected /tokens response shape");
  return token;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "POST" && url.pathname === "/token") {
      const body = await readBody(req);
      let app = "";
      try {
        app = JSON.parse(body.toString("utf8") || "{}").app;
      } catch {
        app = body.toString("utf8");
      }
      const token = await mintToken(app);
      console.log(`[token] minted for ${app} (120 s)`);
      return send(res, 200, token);
    }
    if (req.method === "POST" && url.pathname === "/save") {
      const name = path.basename(url.searchParams.get("name") || "");
      if (!/^[\w.-]+$/.test(name)) return send(res, 400, "bad name");
      fs.mkdirSync(outDir, { recursive: true });
      const body = await readBody(req);
      fs.writeFileSync(path.join(outDir, name), body);
      console.log(`[save] out/${name} (${body.length} bytes)`);
      return send(res, 200, "ok");
    }
    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      const file = MEDIA[url.pathname.slice(7)];
      if (!file) return send(res, 404, "not found");
      const type = file.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
      return send(res, 200, fs.readFileSync(file), type);
    }
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(here, file)), type);
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") return send(res, 204, "");
    send(res, 404, "not found");
  } catch (err) {
    const msg = redact(err && err.message ? err.message : err);
    console.error(`[error] ${req.method} ${url.pathname}: ${msg}`);
    send(res, 500, msg);
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`lucy test server on http://127.0.0.1:${PORT}`));
