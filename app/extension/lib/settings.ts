import { browser } from "wxt/browser";
import { DEFAULT_PORT } from "@signlayer/core";

/** What the card listens to. */
export type Source = "mic" | "tab";
/** Card size (width): S, M, L. */
export type Size = "s" | "m" | "l";

export interface Settings {
  source: Source;
  apiUrl: string;
  size: Size;
}

export const DEFAULTS: Settings = { source: "tab", apiUrl: `http://localhost:${DEFAULT_PORT}`, size: "m" };
export const SIZE_PX: Record<Size, number> = { s: 252, m: 300, l: 372 };

export async function getSettings(): Promise<Settings> {
  const s = (await browser.storage.local.get(["source", "apiUrl", "size"])) as Partial<Settings>;
  return {
    source: s.source === "mic" ? "mic" : "tab",
    apiUrl: typeof s.apiUrl === "string" && s.apiUrl ? s.apiUrl : DEFAULTS.apiUrl,
    size: s.size === "s" || s.size === "l" ? s.size : "m",
  };
}

export const setSettings = (patch: Partial<Settings>) => browser.storage.local.set(patch);
