import { defineConfig, type Plugin } from "vite";
import { createReadStream, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// Serve local files to the viewer: GET /__file/<path>
// <path> is absolute (C:/... or /c/...) or relative to the repo root (the folder above puppet/).
// Dev-only helper so ?motion=out/motion/judy.clean.json and ?video=references/how2sign/judy.mp4 just work.
const repoRoot = resolve(__dirname, "..");

export function resolveLocal(p: string): string {
  let s = decodeURIComponent(p).replace(/\\/g, "/");
  const gitBash = /^\/([a-zA-Z])\/(.*)$/.exec(s); // /c/Users/... (Git Bash style)
  if (gitBash) s = `${gitBash[1]}:/${gitBash[2]}`;
  if (/^\/[a-zA-Z]:\//.test(s)) s = s.slice(1); // /C:/Users/... from a URL path
  return isAbsolute(s) ? s : resolve(repoRoot, s);
}

const TYPES: Record<string, string> = {
  json: "application/json", mp4: "video/mp4", webm: "video/webm", png: "image/png", jpg: "image/jpeg",
  vrm: "application/octet-stream", glb: "model/gltf-binary",
};

function localFiles(): Plugin {
  return {
    name: "local-files",
    configureServer(server) {
      server.middlewares.use("/__file/", (req, res) => {
        const file = resolveLocal((req.url || "").split("?")[0].replace(/^\//, ""));
        let st;
        try { st = statSync(file); } catch { res.statusCode = 404; res.end(`not found: ${file}`); return; }
        const type = TYPES[file.split(".").pop()!.toLowerCase()] || "application/octet-stream";
        res.setHeader("Content-Type", type);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "no-cache");
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
        if (range) { // video seeking needs range requests
          const start = range[1] ? Number(range[1]) : 0;
          const end = range[2] ? Number(range[2]) : st.size - 1;
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
          res.setHeader("Content-Length", end - start + 1);
          createReadStream(file, { start, end }).pipe(res);
        } else {
          res.setHeader("Content-Length", st.size);
          createReadStream(file).pipe(res);
        }
      });
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [localFiles()],
  server: { port: 5181, host: "127.0.0.1" },
  test: { include: ["test/**/*.test.ts"] },
} as any);
