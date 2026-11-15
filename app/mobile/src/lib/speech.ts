// On-device speech recognition (expo-speech-recognition), feature-detected.
// The native module only exists in a development build. In Expo Go (and on web, where we keep the
// typed flow for predictable demos) `speech` is null and the app falls back to "Type to sign".
import { Platform } from "react-native";
import type { ExpoSpeechRecognitionModule as Mod } from "expo-speech-recognition";

type SpeechModule = typeof Mod;

function load(): SpeechModule | null {
  if (Platform.OS === "web") return null;
  try {
    // require() so a missing native module (Expo Go) throws here instead of at import time.
    const m = require("expo-speech-recognition") as { ExpoSpeechRecognitionModule: SpeechModule };
    const mod = m.ExpoSpeechRecognitionModule;
    if (!mod || (typeof mod.isRecognitionAvailable === "function" && !mod.isRecognitionAvailable())) return null;
    return mod;
  } catch {
    return null;
  }
}

export const speech = load();
export const canListen = speech != null;

export interface ListenHandlers {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}

/** Start continuous listening. Returns a stop function. */
export async function startListening(h: ListenHandlers): Promise<(() => void) | null> {
  if (!speech) return null;
  const perm = await speech.requestPermissionsAsync();
  if (!perm.granted) { h.onError("Microphone or speech permission was not granted."); return null; }
  const subs = [
    speech.addListener("result", (e) => {
      const t = e.results[0]?.transcript?.trim() ?? "";
      if (!t) return;
      if (e.isFinal) h.onFinal(t); else h.onInterim(t);
    }),
    speech.addListener("error", (e) => { if (e.error !== "no-speech" && e.error !== "aborted") h.onError(e.message || e.error); }),
    speech.addListener("end", () => h.onEnd()),
  ];
  speech.start({
    lang: "en-US",
    interimResults: true,
    continuous: true,
    requiresOnDeviceRecognition: speech.supportsOnDeviceRecognition?.() ?? false,
    addsPunctuation: true,
    iosTaskHint: "dictation",
  });
  return () => {
    try { speech.stop(); } catch {}
    subs.forEach((s) => s.remove());
  };
}
