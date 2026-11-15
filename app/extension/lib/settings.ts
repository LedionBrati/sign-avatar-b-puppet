import { browser } from "wxt/browser";
import { DEFAULT_PORT } from "@signlayer/core";

/** What the signer listens to. Selected text (context menu / Alt+Shift+S) works on top of any source. */
export type Source = "captions" | "tab" | "mic" | "selection";
export type Size = "s" | "m" | "l";
export type Corner = "tl" | "tr" | "bl" | "br";

export interface Settings {
  /** Signer on/off (popup switch). Explicit actions (context menu, shortcut) work either way. */
  enabled: boolean;
  source: Source;
  size: Size;
  /** Caption sheet under the signer. */
  captions: boolean;
  corner: Corner;
  apiUrl: string;
  /** First-run screen in the popup has been seen. */
  onboarded: boolean;
}

export const DEFAULTS: Settings = {
  enabled: true,
  source: "captions",
  size: "m",
  captions: true,
  corner: "br",
  apiUrl: `http://localhost:${DEFAULT_PORT}`,
  onboarded: false,
};

/** Card width per size, px. */
export const WIDTHS: Record<Size, number> = { s: 196, m: 256, l: 344 };

export const SOURCES: Source[] = ["captions", "tab", "mic", "selection"];
export const SOURCE_LABEL: Record<Source, string> = { captions: "Captions", tab: "Tab audio", mic: "Microphone", selection: "Selected text" };

export async function getSettings(): Promise<Settings> {
  const s = await browser.storage.local.get(Object.keys(DEFAULTS));
  const out: Settings = { ...DEFAULTS, ...(s as Partial<Settings>) };
  if (!SOURCES.includes(out.source)) out.source = DEFAULTS.source;
  return out;
}

export const setSettings = (patch: Partial<Settings>) => browser.storage.local.set(patch);

export function onSettings(cb: (patch: Partial<Settings>) => void) {
  const fn = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== "local") return;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(changes)) if (k in DEFAULTS) patch[k] = v.newValue ?? DEFAULTS[k as keyof Settings];
    if (Object.keys(patch).length) cb(patch as Partial<Settings>);
  };
  browser.storage.onChanged.addListener(fn);
  return () => browser.storage.onChanged.removeListener(fn);
}
