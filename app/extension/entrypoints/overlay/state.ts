// The card's shared state: settings, the API client, and what the listening side is doing.
import { createSignClient, type SignClient } from "@flux/core";
import { getSettings, setSettings } from "@/lib/settings";

export const params = new URLSearchParams(location.search);
/** The tab this card sits on (float.ts passes it). */
export const TAB = Number(params.get("tab")) || 0;
const CLIENT_TIMEOUT_MS = 12_000;

/** Settings, mutated in place as the user changes them. */
export const s = await getSettings();
export let client: SignClient = createSignClient(s.apiUrl, { timeoutMs: CLIENT_TIMEOUT_MS });

/** A new server URL (already validated): saved, and a fresh client for it. */
export function setServer(url: string) {
  s.apiUrl = url;
  setSettings({ apiUrl: url });
  client = createSignClient(url, { timeoutMs: CLIENT_TIMEOUT_MS });
}

export const ui = {
  listening: "off" as "off" | "starting" | "on",
  /** Capture / mic error: one small line under the transcript until the next Start. */
  errorText: "",
  /** Soft placeholder in the transcript. */
  hint: "",
  isOffline: false,
  offlineMsg: "",
};
