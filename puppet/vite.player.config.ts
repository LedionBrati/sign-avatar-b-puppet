// Library build of the instant signer player (src/player.ts) for app/web and others:
//   npm run build:player   ->  dist/signer-player.js (ES module, three.js bundled in)
// The page that uses it serves signer.glb itself (copy puppet/models/signer.glb next to it).
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: { entry: "src/player.ts", formats: ["es"], fileName: () => "signer-player.js" },
  },
});
