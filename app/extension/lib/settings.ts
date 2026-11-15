import { browser } from "wxt/browser";
import { DEFAULT_PORT } from "@signlayer/core";

/** What the side panel listens to. */
export type Source = "mic" | "tab";

export interface Settings {
  source: Source;
  apiUrl: string;
}

export const DEFAULTS: Settings = { source: "mic", apiUrl: `http://localhost:${DEFAULT_PORT}` };

export async function getSettings(): Promise<Settings> {
  const s = (await browser.storage.local.get(["source", "apiUrl"])) as Partial<Settings>;
  return { source: s.source === "tab" ? "tab" : "mic", apiUrl: typeof s.apiUrl === "string" && s.apiUrl ? s.apiUrl : DEFAULTS.apiUrl };
}

export const setSettings = (patch: Partial<Settings>) => browser.storage.local.set(patch);
