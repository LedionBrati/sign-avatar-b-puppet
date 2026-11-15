import { resolve } from "node:path";
import { defineConfig } from "wxt";
import pinned from "./manifest-key.json";

// SIGNLAYER Chrome extension (Manifest V3): a floating, draggable glass card on top of the page. See README.md.
export default defineConfig({
  alias: { "@signlayer/core": resolve(__dirname, "../core/src/index.ts") },
  manifest: {
    name: "SIGNLAYER",
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
    action: { default_title: "SIGNLAYER" },
    // The card's UI is an extension page in an iframe on the site, so the site's CSS and CSP never touch it.
    web_accessible_resources: [{ resources: ["overlay.html"], matches: ["<all_urls>"] }],
  },
});
