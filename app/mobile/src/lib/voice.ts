// Text to speech for sign -> speak: expo-speech (AVSpeechSynthesizer / Android TTS, speechSynthesis on web).
// Works in Expo Go. Repeated identical "speak" messages within a moment are dropped (the page may post
// both to ReactNativeWebView and window.parent).
import * as Speech from "expo-speech";
import { tap } from "./feedback";

let last = { text: "", at: 0 };

export function speakText(text: string, on: { start?: () => void; done?: () => void } = {}): boolean {
  const t = text.trim();
  if (!t) return false;
  const now = Date.now();
  if (t === last.text && now - last.at < 700) return false;
  last = { text: t, at: now };
  tap("start");
  Speech.stop();
  Speech.speak(t, {
    language: "en-US",
    onStart: on.start,
    onDone: on.done,
    onStopped: on.done,
    onError: on.done,
  });
  on.start?.();
  return true;
}

export const stopSpeaking = () => { Speech.stop(); };
