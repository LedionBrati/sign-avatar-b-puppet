// Sign -> speak bridge. The phone does not run MediaPipe itself: it shows the web app's camera screen
// (`<server>/app/#/sign?embed=1`, ROUTES.webApp) in a WebView (iframe on web) and listens for:
//   {type:"sentence", text}  the composed sentence so far (shown in the native caption sheet)
//   {type:"speak", text}     the user tapped Speak in the page (spoken with expo-speech)
// plus {type:"env"} from our own injected script (is the page a secure context with getUserMedia?).
import { Platform } from "react-native";
import { ROUTES } from "@flux/core";

export type BridgeMsg =
  | { type: "sentence"; text: string }
  | { type: "speak"; text: string }
  | { type: "env"; secure: boolean; media: boolean }
  | { type: "error"; message: string };

/** Accepts a JSON string or an object (window.postMessage); anything else is ignored. */
export function parseBridge(data: unknown): BridgeMsg | null {
  let d: unknown = data;
  if (typeof d === "string") {
    try { d = JSON.parse(d); } catch { return null; }
  }
  if (!d || typeof d !== "object") return null;
  const m = d as Record<string, unknown>;
  const text = typeof m.text === "string" ? m.text : "";
  switch (m.type) {
    case "sentence": return { type: "sentence", text };
    case "speak": return { type: "speak", text };
    case "env": return { type: "env", secure: !!m.secure, media: !!m.media };
    case "error": return { type: "error", message: typeof m.message === "string" ? m.message : "Error in the signing page" };
    default: return null;
  }
}

/**
 * The page the Sign screen embeds. Dev override (web preview / tests): `?sign=<url>` on the app's URL.
 */
export function signPageUrl(serverUrl: string): string {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const o = new URLSearchParams(window.location.search).get("sign");
    if (o) return o;
  }
  return `${serverUrl.replace(/\/+$/, "")}${ROUTES.webApp}#/sign?embed=1`;
}

/**
 * Runs in the WebView before the page's own scripts. Forwards window.postMessage traffic (the page may
 * post to `window.parent`, which is `window` at the top level) to React Native, and reports whether
 * getUserMedia is available: WebViews only expose the camera on https:// or http://localhost pages.
 */
export const INJECTED_BRIDGE = `(function(){
  if (window.__slBridge) return; window.__slBridge = 1;
  function send(d){ try { window.ReactNativeWebView.postMessage(typeof d === "string" ? d : JSON.stringify(d)); } catch (e) {} }
  window.addEventListener("message", function(e){ var d = e.data; if (d && (typeof d === "string" || typeof d === "object")) send(d); });
  function env(){ send({ type: "env", secure: !!window.isSecureContext, media: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", env); else env();
})(); true;`;

export type FrameError = { kind: "unreachable" | "not-served" | "page"; detail?: string };

/** Quick check before loading the page, so a dead server or a missing /app/ gives a friendly screen. */
export async function preflight(pageUrl: string, timeoutMs = 6000): Promise<FrameError | null> {
  const url = pageUrl.split("#")[0]!;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    if (Platform.OS === "web") {
      // Cross-origin from the preview: an opaque response still proves the server answers.
      try {
        const r = await fetch(url, { signal: ctl.signal });
        return r.ok ? null : { kind: "not-served", detail: `HTTP ${r.status}` };
      } catch {
        await fetch(url, { mode: "no-cors", signal: ctl.signal });
        return null;
      }
    }
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? null : { kind: "not-served", detail: `HTTP ${r.status}` };
  } catch (e) {
    return { kind: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}
