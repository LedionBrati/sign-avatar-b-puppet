// Messages between the three extension contexts (all chrome.runtime messaging, so they reach every extension page;
// each one carries a `target` and the receiver ignores the rest):
//
//   overlay (the card's iframe, one per tab) ──{target:"bg"}──► background ──{target:"offscreen"}──► offscreen document
//   offscreen ──{target:"overlay", tabId}──► the overlay of that tab (text, level, hint, error, stopped)
//
// The overlay also keeps a runtime port open to the background while it listens: when the card closes or the page
// navigates, the port drops and the background stops the capture.
import type { Source } from "./settings";

export type ToBg =
  | { target: "bg"; type: "start"; tabId: number; source: Source; apiUrl: string }
  | { target: "bg"; type: "stop"; tabId: number }
  | { target: "bg"; type: "open-mic"; tabId: number };

export type ToOffscreen =
  | { target: "offscreen"; type: "start"; tabId: number; kind: Source; streamId?: string; apiUrl: string }
  | { target: "offscreen"; type: "stop"; tabId?: number; reason?: string }
  | { target: "offscreen"; type: "status" };

/** Reply to a start: ok, or a plain-language error ("mic-denied" = open the one-time permission tab). */
export type StartReply = { ok: true } | { ok: false; error: string };

export interface ChunkInfo { ms: number; bytes: number; latency_ms: number; text: string }

export type ToOverlay = { target: "overlay"; tabId: number } & (
  | { type: "text"; text: string; chunk: ChunkInfo }
  | { type: "chunk"; chunk: ChunkInfo }
  | { type: "level"; v: number; voiced: boolean }
  | { type: "hint"; text: string }
  | { type: "error"; text: string }
  | { type: "stopped"; reason: string }
);

export const OVERLAY_PORT = "sl-overlay";
