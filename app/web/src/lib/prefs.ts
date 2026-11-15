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

/** "auto" follows prefers-color-scheme; light/dark pin it via <html data-theme>. Keeps the browser chrome in step. */
export function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  const dark = prefs.theme === "dark" || (prefs.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    if (prefs.theme === "auto") m.content = m.dataset.auto ?? m.content;
    else m.content = dark ? "#050608" : "#f5f5f7";
  });
}
