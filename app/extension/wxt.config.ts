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
    // tabCapture + offscreen: the "Tab audio" source (stream id from the popup click, recorded in an offscreen document).
    permissions: ["storage", "contextMenus", "activeTab", "scripting", "sidePanel", "tabs", "tabCapture", "offscreen"],
    // https: so the background can inject the content script into tabs opened before install (YouTube etc.).
    host_permissions: ["http://*/*", "https://*/*"],
    action: { default_title: "SIGNLAYER" },
    side_panel: { default_path: "sidepanel.html" },
    commands: {
      "sign-selection": {
        suggested_key: { default: "Alt+Shift+S", mac: "Alt+Shift+S" },
        description: "Sign the selected text",
      },
      "toggle-signer": {
        suggested_key: { default: "Alt+Shift+K", mac: "Alt+Shift+K" },
        description: "Show or hide the signer (starts tab audio when that is the source)",
      },
    },
    // The signer runs as an extension page inside an iframe, so a page's CSP never blocks our <video> or API calls.
    web_accessible_resources: [{ resources: ["overlay.html"], matches: ["<all_urls>"] }],
  },
});
