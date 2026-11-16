// User preferences (appearance + captions), kept in localStorage and shared through a tiny external store.
import { useSyncExternalStore } from "react";

export type Theme = "auto" | "light" | "dark";
/** `v` is the prefs schema: 2 = light glass is the default look (older builds defaulted to dark). */
export interface Prefs {
  theme: Theme; captions: boolean; v?: number;
  /** Sign -> voice: closed demo vocabulary with a personal model ("Train my signs"); profile "demo" = the generic one. */
  closedVocab?: boolean; signProfile?: string; signVocab?: string[];
}

const KEY = "sl-prefs";
const V = 2;
const DEFAULTS: Prefs = { theme: "light", captions: true, v: V, closedVocab: true, signProfile: "demo" };
const subs = new Set<() => void>();

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Prefs>;
    const p = { ...DEFAULTS, ...saved };
    // One-time move to the light glass look: a "dark"/"auto" saved by an older (dark-default) build becomes light.
    // Picking Dark again in Settings afterwards sticks (it is saved with v: 2).
    if ((saved.v ?? 0) < V) {
      p.theme = "light";
      p.v = V;
      try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ }
    }
    return p;
  } catch { return DEFAULTS; }
}
let prefs = load();

export const getPrefs = () => prefs;

export function setPrefs(p: Partial<Prefs>) {
  prefs = { ...prefs, ...p, v: V };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
  applyTheme();
  subs.forEach((f) => f());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, getPrefs);
}

/** The app is light (bright cobalt/periwinkle gradient + clear glass) unless "dark" is picked; "auto" from older saves means light.
 *  Sets <html data-theme> and keeps the browser chrome in step. */
export function applyTheme() {
  const dark = prefs.theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => { m.content = dark ? "#04061a" : "#5a74f0"; });
}
