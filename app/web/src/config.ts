// API base: the settings field (localStorage) wins, then VITE_API_URL, then http://localhost:8787 (app/server default).
// "same-origin" (used by `npm run dev:mock`) means the API is served by the page's own origin.
import { DEFAULT_PORT } from "@signlayer/core";

const KEY = "sl-api";
export const ENV_API: string = import.meta.env.VITE_API_URL || `http://localhost:${DEFAULT_PORT}`;

export function getApiSetting(): string {
  try { return localStorage.getItem(KEY) || ""; } catch { return ""; }
}
export function setApiSetting(v: string) {
  try { if (v.trim()) localStorage.setItem(KEY, v.trim()); else localStorage.removeItem(KEY); } catch { /* private mode */ }
}
export function apiBase(): string {
  const v = getApiSetting() || ENV_API;
  return v === "same-origin" ? "" : v.replace(/\/$/, "");
}
export const apiLabel = () => apiBase() || location.origin;
