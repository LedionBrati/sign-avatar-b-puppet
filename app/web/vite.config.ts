import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mockApi } from "./mock/mockApi";

const here = path.dirname(fileURLToPath(import.meta.url));
// The MediaPipe wasm is loaded from jsdelivr at the exact installed package version.
const mpVersion: string = JSON.parse(fs.readFileSync(path.join(here, "node_modules/@mediapipe/tasks-vision/package.json"), "utf8")).version;

// `vite --mode mock`: the dev server also plays the API (same origin), so no app/server is needed.
export default defineConfig(({ mode }) => ({
  // Relative base: the same build runs at / and at /app/ (app/server serves dist there for the phone WebView).
  base: "./",
  plugins: [react(), ...(mode === "mock" ? [mockApi()] : [])],
  // The instant 3D signer (puppet/src/player.ts, three.js) is bundled from source as a lazy chunk (lib/signer3d.ts).
  resolve: { alias: { "@flux/core": path.resolve(here, "../core/src/index.ts"), "@flux/signer-player": path.resolve(here, "../../puppet/src/player.ts") } },
  define: { __MP_VERSION__: JSON.stringify(mpVersion), __ARTIFACT__: "false", ...(mode === "mock" ? { "import.meta.env.VITE_API_URL": JSON.stringify("same-origin") } : {}) },
  server: { port: 5173, host: true, fs: { allow: [path.resolve(here, "..")] } },
  build: { target: "es2022" },
}));
