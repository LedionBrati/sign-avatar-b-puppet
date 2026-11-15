// Microphone level via Web Audio, for the ambient glow and the island's level bars. Best effort: it runs next
// to speech recognition (Chrome/Edge share the mic fine). Skipped on iOS, where a second capture can stall the
// recognizer; callers fall back to a gentle synthetic level.
export interface Meter { level(): number; stop(): void }

export async function openMeter(): Promise<Meter | null> {
  if (!navigator.mediaDevices?.getUserMedia || /iPhone|iPad|iPod/.test(navigator.userAgent)) return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AC();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.5;
    ctx.createMediaStreamSource(stream).connect(an);
    void ctx.resume().catch(() => {});
    const buf = new Float32Array(an.fftSize);
    let smooth = 0;
    return {
      level() {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
        const db = 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-8);
        const l = Math.min(1, Math.max(0, (db + 58) / 40)); // ~-58 dB (room) .. -18 dB (close speech)
        smooth += (l - smooth) * (l > smooth ? 0.4 : 0.07); // fast attack, slow release
        return smooth;
      },
      stop() { stream.getTracks().forEach((t) => t.stop()); void ctx.close().catch(() => {}); },
    };
  } catch {
    return null;
  }
}
