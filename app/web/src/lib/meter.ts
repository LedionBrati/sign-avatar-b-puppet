// Microphone level for the ambient glow and the island's level bars. It reuses the page's one shared mic
// (lib/mic.ts), so it never opens a second capture next to the listener. On iOS, when the browser speech engine
// (lib/speech.ts fallback) owns the mic, a second capture can stall it: skipped there, callers use a synthetic level.
import { acquireMic, micHeld, releaseMic } from "./mic";

export interface Meter { level(): number; stop(): void }

export async function openMeter(): Promise<Meter | null> {
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !micHeld()) return null;
  try {
    const mic = await acquireMic();
    let smooth = 0, stopped = false;
    return {
      level() {
        const l = Math.min(1, Math.max(0, (mic.rmsDb() + 58) / 40)); // ~-58 dB (room) .. -18 dB (close speech)
        smooth += (l - smooth) * (l > smooth ? 0.4 : 0.07); // fast attack, slow release
        return smooth;
      },
      stop() { if (!stopped) { stopped = true; releaseMic(); } },
    };
  } catch {
    return null;
  }
}
