import { resolve } from "node:path";
import { defineConfig } from "wxt";
import pinned from "./manifest-key.json";

// SIGNLAYER Chrome extension (Manifest V3): one side panel. See README.md.
export default defineConfig({
  alias: { "@signlayer/core": resolve(__dirname, "../core/src/index.ts") },
  manifest: {
    name: "SIGNLAYER",
    description: "Hear anything, see it signed. Mic or tab audio, signed in the side panel.",
    // Pinned key: the unpacked extension always gets the same ID.
    key: pinned.key,
    // activeTab + tabCapture: the toolbar click lets the panel capture that tab's audio. storage: source + API URL.
    permissions: ["storage", "sidePanel", "activeTab", "tabCapture"],
    action: { default_title: "SIGNLAYER" },
    side_panel: { default_path: "sidepanel.html" },
  },
});
