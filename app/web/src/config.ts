// API base: the settings field (localStorage) wins, then VITE_API_URL, then the page origin when served at /app/ by app/server, then http://localhost:8787.
// "same-origin" (used by `npm run dev:mock`) means the API is served by the page's own origin.
import { DEFAULT_PORT } from "@signlayer/core";

const KEY = "sl-api";
// A production build served by app/server itself (http://<host>:8787/app/, the phone WebView) talks to that same server.
const servedByApi = import.meta.env.PROD && /^https?:$/.test(location.protocol) && location.pathname.startsWith("/app/");
export const ENV_API: string = import.meta.env.VITE_API_URL || (servedByApi ? location.origin : `http://localhost:${DEFAULT_PORT}`);

export function getApiSetting(): string {
  try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
}
export function setApiSetting(v: string) {
  try { if (v.trim()) localStorage.setItem(KEY, v.trim()); else localStorage.removeItem(KEY); } catch { /* private mode */ }
}
export function apiBase(): string {
  // The deployed engineering preview has its API on the same origin. A saved
  // URL from an older preview must not send requests to a stale deployment.
  if (import.meta.env.VITE_ENGINEERING_PREVIEW === "1" && ENV_API === "same-origin") return "";
  const v = getApiSetting() || ENV_API;
  return v === "same-origin" ? "" : v.replace(/\/$/, "");
}
export const apiLabel = () => apiBase() || location.origin;
