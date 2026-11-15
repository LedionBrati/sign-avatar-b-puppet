import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { mockApi } from "./mock/mockApi";

const here = path.dirname(fileURLToPath(import.meta.url));

// `vite --mode mock`: the dev server also plays the API (same origin), so no app/server is needed.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "mock" ? [mockApi()] : [])],
  resolve: { alias: { "@signlayer/core": path.resolve(here, "../core/src/index.ts") } },
  define: mode === "mock" ? { "import.meta.env.VITE_API_URL": JSON.stringify("same-origin") } : {},
  server: { port: 5173, host: true, fs: { allow: [path.resolve(here, "..")] } },
  build: { target: "es2022" },
}));
