// Dev-only mock of app/server, so the web app runs before the real server exists.
// `npm run dev:mock` serves POST /api/sign, GET /api/vocab, GET /api/health and GET /clips/* from the Vite dev server.
// The translator here is a toy (word lookup against clips/manifest.json); the real one is translate/ behind app/server.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

interface ManifestEntry { gloss: string; file: string; frames: number; seconds: number }

function findClipsDir(root: string): string | null {
  const repo = path.resolve(root, "../..");
  const candidates = [
    process.env.CLIPS_DIR,
    path.join(repo, "out/realtime/clips"),
    path.resolve(repo, "../sign-avatar-b-puppet/out/realtime/clips"),
  ].filter(Boolean) as string[];
  return candidates.find((d) => fs.existsSync(path.join(d, "manifest.json"))) ?? null;
}

// English word -> motion_id. Two-word phrases first.
const PHRASES: Record<string, string> = { "thank you": "THANK_YOU", "thanks you": "THANK_YOU" };
const WORDS: Record<string, string> = { hello: "HELLO", hi: "HELLO", hey: "HELLO", my: "MY", name: "NAME", thanks: "THANK_YOU", see: "SEE", you: "YOU", later: "LATER", where: "WHERE", hurt: "HURT", hurts: "HURT", pain: "HURT" };
// Words ASL drops (no sign, not "unsupported").
const DROP = new Set(["a", "an", "the", "is", "am", "are", "be", "to", "of", "and", "it", "does", "do", "so", "very", "much", "please", "oh", "um", "uh"]);

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9'’-]/g, "").replace(/’/g, "'");

export function mockSign(text: string, manifest: Record<string, ManifestEntry>) {
  const t0 = performance.now();
  const words = text.trim().split(/\s+/).filter(Boolean);
  const n = words.map(norm);
  const playlist: { motion_id: string; gloss: string; url: string; duration_s: number; word_index: number }[] = [];
  const unsupported: string[] = [];
  const fingerspell: string[] = [];
  const push = (id: string, i: number) => {
    const m = manifest[id];
    if (m) playlist.push({ motion_id: id, gloss: m.gloss, url: `/clips/${m.file}`, duration_s: m.seconds, word_index: i });
  };
  for (let i = 0; i < n.length; i++) {
    const w = n[i]!;
    const two = `${w} ${n[i + 1] ?? ""}`;
    if (PHRASES[two]) {
      const id = PHRASES[two]!;
      if (id.includes(" ")) id.split(" ").forEach((p, k) => push(p, i + k));
      else push(id, i);
      i++;
      continue;
    }
    if (WORDS[w] && manifest[WORDS[w]!]) { push(WORDS[w]!, i); continue; }
    if (!w || DROP.has(w)) continue;
    // A capitalised word mid-sentence after "is"/"name" reads as a name: the translator would fingerspell it.
    if (i > 0 && /^[A-Z]/.test(words[i]!) && ["is", "name", "i'm"].includes(n[i - 1]!)) { fingerspell.push(words[i]!.replace(/[^\p{L}'-]/gu, "")); continue; }
    unsupported.push(w);
  }
  const ms = performance.now() - t0;
  return { text, words, playlist, unsupported, fingerspell, markers: [], plan: { mock: true }, timings: { translate_ms: ms, total_ms: ms } };
}

export function mockApi(): Plugin {
  return {
    name: "signlayer-mock-api",
    configureServer(server) {
      const dir = findClipsDir(server.config.root);
      if (!dir) server.config.logger.warn("[mock] no clips/manifest.json found; set CLIPS_DIR");
      else server.config.logger.info(`[mock] serving clips from ${dir}`);
      const manifest = (): Record<string, ManifestEntry> => (dir ? JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) : {});
      const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(body));
      };
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
          res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" });
          return res.end();
        }
        if (url.pathname === "/api/health") return json(res, 200, { ok: true, signs: Object.keys(manifest()).length, semantic: "off" });
        if (url.pathname === "/api/vocab")
          return json(res, 200, { signs: Object.entries(manifest()).map(([id, m]) => ({ motion_id: id, gloss: m.gloss, duration_s: m.seconds })) });
        if (url.pathname === "/api/sign" && req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            try {
              const { text } = JSON.parse(body || "{}");
              if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: { code: "bad_request", message: "text is required" } });
              // A little latency, like a real round trip.
              setTimeout(() => json(res, 200, mockSign(text, manifest())), 120);
            } catch {
              json(res, 400, { error: { code: "bad_json", message: "invalid JSON" } });
            }
          });
          return;
        }
        if (url.pathname.startsWith("/clips/") && dir) {
          const file = path.join(dir, path.basename(decodeURIComponent(url.pathname)));
          if (!file.endsWith(".mp4") || !fs.existsSync(file)) return next();
          const size = fs.statSync(file).size;
          const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
          const head = { "content-type": "video/mp4", "accept-ranges": "bytes", "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" };
          if (range) {
            const start = range[1] ? +range[1] : 0;
            const end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
            res.writeHead(206, { ...head, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
            return fs.createReadStream(file, { start, end }).pipe(res);
          }
          res.writeHead(200, { ...head, "content-length": size });
          return fs.createReadStream(file).pipe(res);
        }
        next();
      });
    },
  };
}
