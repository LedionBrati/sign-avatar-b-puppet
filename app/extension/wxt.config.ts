import { resolve } from "node:path";
import { defineConfig } from "wxt";
import pinned from "./manifest-key.json";

// Flux Chrome extension (Manifest V3): a floating, draggable glass card on top of the page. See README.md.
export default defineConfig({
  // The instant 3D signer (puppet/src/player.ts + three.js) is bundled from source as a lazy chunk of the card
  // (an extension page, so WebGL works); its avatar (signer.glb) and motions come from the server.
  alias: { "@flux/core": resolve(__dirname, "../core/src/index.ts"), "@flux/signer-player": resolve(__dirname, "../../puppet/src/player.ts") },
  hooks: {
    // The typecheck (tsc --noEmit) sees the player through its declaration instead: the puppet sources are not
    // written for this project's strict flags (noUncheckedIndexedAccess, ...), and the card only needs its shape.
    "prepare:tsconfig": (_wxt, { tsconfig }) => {
      const paths: Record<string, string[]> = tsconfig.compilerOptions.paths;
      paths["@flux/signer-player"] = ["../../core/src/signer-player.d.ts"];
      delete paths["@flux/signer-player/*"];
    },
  },
  manifest: {
    name: "Flux",
    short_name: "Flux",
    description: "Hear anything, see it signed. Click the icon: a small signer card floats over the page, signing its audio or your mic.",
    // Pinned key: the unpacked extension always gets the same ID.
    key: pinned.key,
    // activeTab: the toolbar click lets us inject the card into that tab and capture its audio (tabCapture).
    // scripting: inject the card. offscreen: the audio capture + speech-to-text document. storage: settings, position.
    permissions: ["storage", "activeTab", "scripting", "tabCapture", "offscreen"],
    // The default server is a local one. Extension pages and the offscreen document count as loopback for Chrome's
    // Local Network Access rules, so no prompt; the server sends CORS * (and the PNA preflight header) anyway, which
    // is all an https tunnel URL needs. This only makes localhost robust even for a response without CORS headers.
    host_permissions: ["http://localhost/*", "http://127.0.0.1/*"],
    action: { default_title: "Flux" },
    // The card's UI is an extension page in an iframe on the site, so the site's CSS and CSP never touch it.
    web_accessible_resources: [{ resources: ["overlay.html"], matches: ["<all_urls>"] }],
  },
});
