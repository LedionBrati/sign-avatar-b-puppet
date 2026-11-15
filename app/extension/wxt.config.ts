import { resolve } from "node:path";
import { defineConfig } from "wxt";
import pinned from "./manifest-key.json";

// SIGNLAYER Chrome extension (Manifest V3). See README.md.
export default defineConfig({
  alias: { "@signlayer/core": resolve(__dirname, "../core/src/index.ts") },
  manifest: {
    name: "SIGNLAYER",
    description: "Hear anything, see it signed. A signer in the corner of any video, call or lecture.",
    // Pinned key: the unpacked extension always gets the same ID, so the API can allow it by origin (CORS).
    key: pinned.key,
    permissions: ["storage", "contextMenus", "activeTab", "scripting", "sidePanel", "tabs"],
    host_permissions: ["http://localhost/*", "http://127.0.0.1/*", "http://*/*"],
    action: { default_title: "SIGNLAYER" },
    side_panel: { default_path: "sidepanel.html" },
    commands: {
      "sign-selection": {
        suggested_key: { default: "Alt+Shift+S", mac: "Alt+Shift+S" },
        description: "Sign the selected text",
      },
    },
    // The signer runs as an extension page inside an iframe, so a page's CSP never blocks our <video> or API calls.
    web_accessible_resources: [{ resources: ["overlay.html"], matches: ["<all_urls>"] }],
  },
});
