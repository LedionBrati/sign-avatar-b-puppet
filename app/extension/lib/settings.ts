import { browser } from "wxt/browser";
import { DEFAULT_PORT } from "@signlayer/core";

export type Source = "captions" | "mic" | "selection";
export type Size = "s" | "m" | "l";
export type Corner = "tl" | "tr" | "bl" | "br";

export interface Settings {
  /** Signer on/off (popup switch). Explicit actions (context menu, shortcut) work either way. */
  enabled: boolean;
  /** What the signer listens to. Selected text always works on top of this. */
  source: Source;
  size: Size;
  /** Caption sheet under the signer. */
  captions: boolean;
  corner: Corner;
  apiUrl: string;
}

export const DEFAULTS: Settings = {
  enabled: true,
  source: "captions",
  size: "m",
  captions: true,
  corner: "br",
  apiUrl: `http://localhost:${DEFAULT_PORT}`,
};

/** Card width per size, px (the design's 190/230/330, a touch larger so captions stay readable). */
export const WIDTHS: Record<Size, number> = { s: 200, m: 260, l: 360 };

export async function getSettings(): Promise<Settings> {
  const s = await browser.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...(s as Partial<Settings>) };
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

export const SOURCE_LABEL: Record<Source, string> = { captions: "Captions", mic: "Microphone", selection: "Selected text" };
