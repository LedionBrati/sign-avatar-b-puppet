// User preferences (appearance + captions), kept in localStorage and shared through a tiny external store.
import { useSyncExternalStore } from "react";

export type Theme = "auto" | "light" | "dark";
export interface Prefs { theme: Theme; captions: boolean }

const KEY = "sl-prefs";
const DEFAULTS: Prefs = { theme: "auto", captions: true };
const subs = new Set<() => void>();

function load(): Prefs {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Prefs>) }; } catch { return DEFAULTS; }
}
let prefs = load();

export const getPrefs = () => prefs;

export function setPrefs(p: Partial<Prefs>) {
  prefs = { ...prefs, ...p };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  applyTheme();
  subs.forEach((f) => f());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, getPrefs);
}

/** The app is dark (deep ink + cobalt glass) unless "light" (a cobalt-mist glass variant) is picked. "auto" is kept for
 *  saved prefs from older builds and means dark. Sets <html data-theme> and keeps the browser chrome in step. */
export function applyTheme() {
  const light = prefs.theme === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => { m.content = light ? "#c9d2f2" : "#04061a"; });
}
