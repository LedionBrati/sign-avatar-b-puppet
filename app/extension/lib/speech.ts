// Web Speech API in the side panel (same restart logic as app/web/src/lib/speech.ts). Continuous, interim results.
// Chrome ends a session after silence or a network hiccup: we restart until stop() is called, and drop a final that
// a restarted session re-sends. Side panels can't show Chrome's permission prompt: "denied" before any session has
// worked means "grant it once in a tab" (see entrypoints/mic).

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
export const speechSupported = () => !!Ctor();

export type SpeechErrorKind = "denied" | "no-mic" | "network" | "other";
export interface SpeechHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(kind: SpeechErrorKind, raw: string): void;
}

export function createListener(h: SpeechHandlers) {
  const C = Ctor();
  if (!C) throw new Error("speech recognition unsupported");
  let active = false, rec: Rec | null = null, fails = 0, hadSession = false, lastFinal = "", lastFinalAt = 0;

  function boot(reuse = false) {
    if (reuse && rec) {
      try { rec.start(); return; } catch { /* fall through to a fresh instance */ }
    }
    rec = new C!();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language?.startsWith("en") ? navigator.language : "en-US";
    rec.maxAlternatives = 1;
    rec.onstart = () => { fails = 0; hadSession = true; };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const t = r[0].transcript.trim();
        if (!t) continue;
        if (r.isFinal) {
          const now = Date.now();
          if (t.toLowerCase() === lastFinal && now - lastFinalAt < 3000) continue;
          lastFinal = t.toLowerCase(); lastFinalAt = now;
          h.onFinal(t);
        } else interim += (interim ? " " : "") + t;
      }
      h.onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (hadSession && (e.error === "not-allowed" || e.error === "service-not-allowed")) return; // a refused restart: retry in onend
      const kind: SpeechErrorKind = e.error === "not-allowed" || e.error === "service-not-allowed" ? "denied"
        : e.error === "audio-capture" ? "no-mic" : e.error === "network" ? "network" : "other";
      if (kind === "denied" || kind === "no-mic") active = false;
      h.onError(kind, e.error);
    };
    rec.onend = () => {
      if (!active) return;
      if (++fails < 8) setTimeout(() => active && boot(fails <= 2), fails <= 2 ? 120 : 400 * fails);
      else { active = false; h.onError("other", "speech recognition keeps stopping"); }
    };
    try { rec.start(); } catch (err) { h.onError("other", String(err)); }
  }

  return {
    start() { if (!active) { active = true; fails = 0; boot(true); } },
    stop() { active = false; try { rec?.abort(); } catch { /* already stopped */ } h.onInterim(""); },
    get active() { return active; },
  };
}
