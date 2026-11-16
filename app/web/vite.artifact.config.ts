// Standalone build of the web app for a claude.ai Artifact (no server):  npm run build:artifact
//   -> out/artifact-app/index.html   ONE body fragment: <title> + Google Fonts link + inline <style> + markup + inline
//                                    <script type="module">. No doctype/html/head/body (the host adds them), no other
//                                    scripts, chunks, service worker, manifest or icons (the sandbox CSP blocks them).
//   -> out/artifact-app/clips/*.mp4  every clip of the clip dirs (first dir wins on duplicates), fetched by relative URL
//   -> out/artifact-app/files.json   {published path: local path} for publishing
// The API runs in the page (src/artifact/shim.ts: rules translator + playlist + safety gate of app/server, relaxed).
// Clip dirs: ARTIFACT_CLIPS_DIRS ("a;b"), default out/realtime/{clips,clips-mass} of this checkout, or of the main
// checkout next to it (../sign-avatar-b-puppet) when this worktree has none.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const outDir = path.join(repo, "out/artifact-app");
const REALTIME = [path.join(repo, "out/realtime"), path.resolve(repo, "../sign-avatar-b-puppet/out/realtime")]
  .find((d) => fs.existsSync(path.join(d, "clips/manifest.json"))) ?? path.join(repo, "out/realtime");
const clipDirs = (process.env.ARTIFACT_CLIPS_DIRS ?? `${path.join(REALTIME, "clips")};${path.join(REALTIME, "clips-mass")}`).split(/[;,]/).map((d) => d.trim()).filter(Boolean);
const FPS = 24;
const BUDGET = 60 * 1024 * 1024; // the artifact allows 64 MB per version; keep headroom for the page
const MAX_FILE = 16 * 1024 * 1024;
const mpVersion: string = JSON.parse(fs.readFileSync(path.join(here, "node_modules/@mediapipe/tasks-vision/package.json"), "utf8")).version;

interface Clip { motion_id: string; gloss: string; file: string; duration_s: number; src: string }

/** Same rules as app/server/lib/clips.mjs loadClipSets: manifest + file on disk, first dir wins, no letter clips here. */
function loadClips(): Clip[] {
  const byId = new Map<string, Clip>();
  const names = new Map<string, string>(); // published name -> source (aliases like HOST share TAKE_UP.mp4)
  for (const dir of clipDirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Record<string, { gloss?: string; file?: string; seconds?: number; frames?: number }>;
    for (const [motion_id, e] of Object.entries(manifest)) {
      if (!e || typeof e.file !== "string" || typeof e.gloss !== "string" || !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(motion_id)) continue;
      if (/^FS_[A-Z]$/.test(motion_id) || byId.has(motion_id)) continue;
      const src = path.resolve(dir, e.file);
      if (!fs.existsSync(src)) { console.warn(`[artifact] missing clip ${src}`); continue; }
      let name = path.basename(src);
      if (names.has(name) && names.get(name) !== src) name = `${motion_id}-${name}`;
      names.set(name, src);
      const seconds = Number(e.seconds) > 0 ? Number(e.seconds) : Number(e.frames) > 0 ? Number(e.frames) / FPS : 0;
      byId.set(motion_id, { motion_id, gloss: e.gloss, file: `clips/${name}`, duration_s: Math.round(seconds * 1000) / 1000, src });
    }
  }
  return [...byId.values()];
}

function artifact(): Plugin {
  const clips = loadClips();
  const VIRTUAL = "virtual:artifact-clips";
  return {
    name: "signlayer-artifact",
    enforce: "post", // after vite:css-post has emitted the CSS asset
    resolveId: (id) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
    load: (id) => id === `\0${VIRTUAL}` ? `export const CLIPS = ${JSON.stringify(clips.map(({ src: _src, ...c }) => c))};` : null,
    generateBundle: { order: "post", handler(_opts, bundle) {
      let js = "", css = "";
      for (const [name, out] of Object.entries(bundle)) {
        if (out.type === "chunk") { if (js) throw new Error(`artifact build must be one chunk (also got ${name})`); js = out.code; }
        else if (name.endsWith(".css")) css += String(out.source);
        else throw new Error(`artifact build emitted an extra file: ${name}`);
        delete bundle[name];
      }
      if (!css) throw new Error("artifact build produced no CSS");
      if (/@mediapipe|holistic_landmarker|serviceWorker\.register/.test(js)) throw new Error("artifact bundle still contains MediaPipe or a service worker");
      // Inline script/style safety: nothing may close the element early.
      js = js.replace(/<\/script/gi, "<\\/script");
      if (js.includes("<!--")) throw new Error("bundle contains '<!--'; escape it before inlining");
      css = css.replace(/<\/style/gi, "<\\/style");
      const html = [
        "<title>SIGNLAYER</title>",
        `<meta name="description" content="Hear anything. See it signed. Live sign language with captions.">`,
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400..700&family=Inter:opsz,wght@14..32,400..700&family=Newsreader:opsz,wght@6..72,400..700&display=swap">`,
        `<style>${css}</style>`,
        `<div id="root"></div>`,
        `<script type="module">${js}</script>`,
        "",
      ].join("\n");
      this.emitFile({ type: "asset", fileName: "index.html", source: html });
    } },
    writeBundle() {
      const dest = path.join(outDir, "clips");
      fs.mkdirSync(dest, { recursive: true });
      const unique = [...new Map(clips.map((c) => [c.file, c])).values()]; // one file per path
      for (const c of unique) fs.copyFileSync(c.src, path.join(outDir, c.file));
      const size = (f: string) => fs.statSync(path.join(outDir, f)).size;
      let total = unique.reduce((s, c) => s + size(c.file), 0);
      if (total > BUDGET) {
        // Same resolution and fps, smaller files.
        console.log(`[artifact] clips are ${(total / 2 ** 20).toFixed(1)} MB > budget: re-encoding at crf 24`);
        for (const c of unique) {
          const out = path.join(outDir, c.file), tmp = `${out}.tmp.mp4`;
          execFileSync("ffmpeg", ["-v", "error", "-y", "-i", c.src, "-c:v", "libx264", "-crf", "24", "-preset", "slow", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", tmp]);
          fs.renameSync(tmp, out);
        }
        total = unique.reduce((s, c) => s + size(c.file), 0);
      }
      const page = size("index.html");
      const files: Record<string, string> = {};
      for (const c of unique) {
        if (size(c.file) > MAX_FILE) throw new Error(`${c.file} is over 16 MB`);
        files[c.file] = c.file;
      }
      fs.writeFileSync(path.join(outDir, "files.json"), JSON.stringify(files, null, 2) + "\n");
      const n = unique.length + 1;
      if (n > 255) throw new Error(`${n} files > 255`);
      if (page + total > 64 * 2 ** 20) throw new Error("artifact is over 64 MB");
      console.log(`[artifact] index.html ${(page / 1024).toFixed(0)} KB · ${clips.length} signs / ${unique.length} clips ${(total / 2 ** 20).toFixed(1)} MB · ${outDir}`);
    },
  };
}

export default defineConfig({
  base: "./",
  publicDir: false, // no service worker, manifest or icons in the artifact
  plugins: [react(), artifact()],
  resolve: {
    alias: {
      "@signlayer/core": path.resolve(here, "../core/src/index.ts"),
      "@sl/translate": path.resolve(repo, "translate/index.mjs"),
      "@sl/sign": path.resolve(repo, "app/server/lib/sign.mjs"),
      "@sl/safety": path.resolve(repo, "app/server/lib/semantic-safety.mjs"),
      // translate/semantic.mjs imports it lazily; the artifact never runs the semantic layer.
      "@huggingface/transformers": path.resolve(here, "src/artifact/stub-transformers.ts"),
      "@signlayer/signer-player": path.resolve(here, "src/artifact/stub-signer-player.ts"),
    },
  },
  define: { __ARTIFACT__: "true", __MP_VERSION__: JSON.stringify(mpVersion) },
  build: {
    target: "es2022",
    outDir,
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    modulePreload: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: path.resolve(here, "src/artifact/entry.ts"),
      output: { format: "es", inlineDynamicImports: true, entryFileNames: "app.js" },
    },
  },
});
