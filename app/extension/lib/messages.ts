// Message shapes between the extension's parts.
//
//   content script / side panel ──runtime.sendMessage──► background ──port──► overlay iframe (in that tab)
//   background ──tabs.sendMessage──► content script (mount the iframe)
//   overlay iframe ──window.parent.postMessage──► content script (drag, height, size, close)
import type { Source, Size } from "./settings";

/** To the background service worker. */
export type ToBackground =
  | { type: "sign"; text: string; source: Source; target?: "sender" | "active" }
  | { type: "heard"; text: string; source: Source; target?: "sender" | "active" }
  | { type: "health" };

/** Background -> overlay (over the "overlay" port). */
export type ToOverlay =
  | { type: "sign"; text: string; source: Source }
  | { type: "heard"; text: string; source: Source };

/** Background -> content script. */
export type ToContent = { type: "mount" } | { type: "ping" };

/** Overlay iframe -> its content script (postMessage; the content script checks event.source). */
export type FromOverlay =
  | { sl: 1; type: "drag"; dx: number; dy: number }
  | { sl: 1; type: "dragend" }
  | { sl: 1; type: "height"; h: number }
  | { sl: 1; type: "size"; size: Size }
  | { sl: 1; type: "close" };

export type HealthResult =
  | { ok: true; signs: number; semantic: string; url: string }
  | { ok: false; error: string; url: string };
