// "#/sign?embed=1": the phone app's WebView (app/mobile) shows this screen and listens for its results.
import { useEffect } from "react";

declare global { interface Window { ReactNativeWebView?: { postMessage(s: string): void } } }

export type EmbedMsg = { type: "sentence" | "speak"; text: string };

/** The phone app's WebView gets a JSON string; its web/iframe fallback gets the object on window "message". */
export function postToApp(msg: EmbedMsg) {
  try { window.ReactNativeWebView?.postMessage(JSON.stringify(msg)); } catch { /* not in a WebView */ }
  try { if (window.parent !== window) window.parent.postMessage(msg, "*"); } catch { /* cross-origin parent gone */ }
}

/** Embedded: the sentence so far goes to the app on every change. */
export function useEmbedSentence(embed: boolean, sentence: string) {
  useEffect(() => { if (embed) postToApp({ type: "sentence", text: sentence }); }, [sentence, embed]);
}
