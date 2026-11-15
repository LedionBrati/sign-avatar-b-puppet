// Web Speech API wrapper (Chrome/Edge/Safari: webkitSpeechRecognition). Continuous, interim results, en-US.
// Every engine ends sessions on its own: Chrome after silence, iOS Safari after EACH phrase (it ignores
// `continuous`). We restart until stop() is called. iOS may refuse a restart that is not triggered by a tap
// ("not-allowed" even though permission was granted): after a session has worked once, that is a pause, not a
// denial: retry with backoff, then ask the user to tap ("paused") instead of reporting the mic as blocked.

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

export type SpeechErrorKind = "denied" | "no-mic" | "network" | "paused" | "other";
export interface SpeechHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onError(kind: SpeechErrorKind, raw: string): void;
  onState?(listening: boolean): void;
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
    rec.lang = "en-US";
    rec.maxAlternatives = 1;
    rec.onstart = () => { fails = 0; hadSession = true; h.onState?.(true); };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const t = r[0].transcript.trim();
        if (!t) continue;
        if (r.isFinal) {
          // Some engines re-send the last phrase after a restart: drop an identical final within 3 s.
          const now = Date.now();
          if (t.toLowerCase() === lastFinal && now - lastFinalAt < 3000) continue;
          lastFinal = t.toLowerCase(); lastFinalAt = now;
          h.onFinal(t);
        }
        else interim += (interim ? " " : "") + t;
      }
      h.onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      // iOS: a restart without a tap is refused as "not-allowed" even though the mic was granted. Retry in onend.
      if (hadSession && (e.error === "not-allowed" || e.error === "service-not-allowed")) return;
      const kind: SpeechErrorKind = e.error === "not-allowed" || e.error === "service-not-allowed" ? "denied"
        : e.error === "audio-capture" ? "no-mic" : e.error === "network" ? "network" : "other";
      if (kind !== "other") active = false;
      h.onError(kind, e.error);
    };
    rec.onend = () => {
      h.onState?.(false);
      if (!active) return;
      if (++fails < 8) setTimeout(() => active && boot(fails <= 2), fails <= 2 ? 120 : 400 * fails);
      else {
        active = false;
        h.onError(hadSession ? "paused" : "other", "restart refused");
      }
    };
    try { rec.start(); } catch (err) { h.onError("other", String(err)); }
  }

  return {
    start() { if (!active) { active = true; fails = 0; boot(true); } },
    stop() { active = false; try { rec?.stop(); } catch { /* already stopped */ } h.onInterim(""); },
    get active() { return active; },
  };
}
