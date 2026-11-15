// Web Speech API wrapper (Chrome/Edge: webkitSpeechRecognition). Continuous, interim results, en-US.
// Chrome ends a session after a stretch of silence, so we restart until stop() is called.

type Rec = {
  continuous: boolean; interimResults: boolean; lang: string; maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type RecCtor = new () => Rec;

const Ctor = (): RecCtor | undefined => {
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};
export const speechSupported = () => typeof window !== "undefined" && !!Ctor();

export type SpeechErrorKind = "denied" | "no-mic" | "network" | "other";
export interface SpeechHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(kind: SpeechErrorKind, raw: string): void;
  onState?(listening: boolean): void;
}

export function createListener(h: SpeechHandlers) {
  const C = Ctor();
  if (!C) throw new Error("speech recognition unsupported");
  let active = false, rec: Rec | null = null, fails = 0;

  function boot() {
    rec = new C!();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;
    rec.onstart = () => { fails = 0; h.onState?.(true); };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const t = r[0].transcript.trim();
        if (!t) continue;
        if (r.isFinal) h.onFinal(t);
        else interim += (interim ? " " : "") + t;
      }
      h.onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      const kind: SpeechErrorKind = e.error === "not-allowed" || e.error === "service-not-allowed" ? "denied"
        : e.error === "audio-capture" ? "no-mic" : e.error === "network" ? "network" : "other";
      if (kind !== "other") active = false;
      h.onError(kind, e.error);
    };
    rec.onend = () => {
      h.onState?.(false);
      if (active && ++fails < 8) setTimeout(() => active && boot(), 150);
      else active = false;
    };
    try { rec.start(); } catch (err) { h.onError("other", String(err)); }
  }

  return {
    start() { if (!active) { active = true; boot(); } },
    stop() { active = false; try { rec?.stop(); } catch { /* already stopped */ } h.onInterim(""); },
    get active() { return active; },
  };
}
