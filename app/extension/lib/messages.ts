// Message shapes between the extension's parts.
//
//   content script / side panel / offscreen ──runtime.sendMessage──► background ──port──► overlay iframe (in that tab)
//   background ──tabs.sendMessage──► content script (mount / unmount / toggle the iframe)
//   background ──runtime.sendMessage({target: "offscreen"})──► offscreen document (tab audio capture)
//   overlay iframe ──window.parent.postMessage──► content script (drag, height, close)
import type { Source } from "./settings";

/** Where a phrase came from, finer than Source (shown in the status pill). */
export type Origin = "transcript" | "captions" | "texttrack" | "tab" | "mic" | "selection";

export type TabAudioState = "off" | "starting" | "listening" | "error";

/** Caption watcher state (content script), for the overlay's status pill. */
export type SourceState =
  | { kind: "idle" }
  | { kind: "listening"; origin: Origin }
  | { kind: "paused"; origin: Origin }
  | { kind: "ad" }
  | { kind: "need-cc" };

/** To the background service worker. */
export type ToBackground =
  | { type: "sign"; text: string; source: Source; origin?: Origin; next?: string; target?: "sender" | "active"; tabId?: number }
  | { type: "heard"; text: string; source: Source; target?: "sender" | "active"; tabId?: number }
  | { type: "source-state"; state: SourceState }
  /** Seek / new video: drop what the signer has queued. */
  | { type: "reset" }
  /** Content script is up in this tab: flushes anything queued before it loaded; mounts the signer if it has a source. */
  | { type: "hello"; wantOverlay: boolean }
  | { type: "health" }
  /** Popup / shortcut: start or stop tab audio (the click is the user gesture tabCapture needs). */
  | { type: "tab-audio"; on: boolean; tabId?: number }
  | { type: "tab-audio-status" }
  /** Offscreen -> background. */
  | { type: "tab-audio-state"; tabId: number; state: TabAudioState; detail?: string; level?: number }
  | { type: "tab-audio-text"; tabId: number; text: string; latency_ms: number }
  /** Popup: show the signer in the active tab now. */
  | { type: "mount-active" };

/** Background -> overlay (over the "overlay" port). */
export type ToOverlay =
  | { type: "sign"; text: string; source: Source; origin?: Origin; next?: string; latency_ms?: number }
  | { type: "heard"; text: string; source: Source }
  | { type: "source-state"; state: SourceState }
  | { type: "tab-audio-state"; state: TabAudioState; detail?: string; level?: number }
  | { type: "reset" };

/** Background -> content script. */
export type ToContent = { type: "mount" } | { type: "unmount" } | { type: "toggle" } | { type: "ping" };

/** Overlay iframe -> its content script (postMessage; the content script checks event.source). */
export type FromOverlay =
  | { sl: 1; type: "dragstart"; x: number; y: number }
  | { sl: 1; type: "drag"; dx: number; dy: number }
  | { sl: 1; type: "dragend" }
  | { sl: 1; type: "height"; h: number }
  | { sl: 1; type: "close" };

export type HealthResult =
  | { ok: true; signs: number; semantic: string; agent?: string; transcribe?: string; url: string }
  | { ok: false; error: string; url: string };

export type TabAudioStatus = { tabId: number | null; state: TabAudioState; detail?: string };
