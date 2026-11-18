// Is the server there? GET /api/health on open, on Retry and after a server change; while offline it is checked
// quietly every 10 s, so the card comes back by itself once the server is up.
import { esc } from "@/lib/brand";
import { showNeutral } from "./player";
import { get3d, restUrl } from "./signer3d";
import { render } from "./status";
import { client, s, ui } from "./state";

export function offline(e: unknown) {
  let host = s.apiUrl;
  try { host = new URL(s.apiUrl).host; } catch { /* keep */ }
  ui.offlineMsg = `Can't reach <b>${esc(host)}</b>.`;
  console.warn("[flux]", e);
  ui.isOffline = true;
  render();
}

export async function checkHealth() {
  try {
    const h = await client.health();
    // Keep the 3D signer warm: load its bundle + avatar in the background once the server has one.
    if (h.motion?.model) void get3d().warm(restUrl()).catch(() => {});
    if (ui.isOffline) { ui.isOffline = false; render(); }
    showNeutral();
  } catch (e) {
    offline(e);
  }
}

export function initHealth() {
  setInterval(() => { if (ui.isOffline && !document.hidden) checkHealth(); }, 10_000);
}
