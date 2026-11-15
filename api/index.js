// Vercel entry point for the existing Node API. The rewrite passes the original
// /api/* path as __path; the shared app then handles it exactly as it does locally.
import { resolve } from "node:path";
import { createApp } from "../app/server/index.mjs";

const localClips = resolve(process.cwd(), "public/clips");
const clipsDir = process.env.CLIPS_DIR || localClips;
const app = createApp({ clipsDirs: [clipsDir], semantic: false });

export default function handler(req, res) {
  const incoming = new URL(req.url ?? "/", "https://signlayer.invalid");
  const path = incoming.searchParams.get("__path");
  if (!path || !/^[a-z0-9._/-]+$/i.test(path) || path.includes("..")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "Unknown API route" } }));
    return;
  }
  incoming.searchParams.delete("__path");
  req.url = `/api/${path}${incoming.search}`;
  app.server.emit("request", req, res);
}
