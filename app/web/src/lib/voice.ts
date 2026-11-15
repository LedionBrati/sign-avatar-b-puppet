// Natural voice for sign -> speak: one reused <audio> element plays the server's /api/speak mp3s. The camera screen
// speaks without a gesture, so the element is unlocked on the first tap (a silent clip played inside the gesture);
// if play() is still refused, the caller falls back to speechSynthesis.
let el: HTMLAudioElement | null = null;
let url = "";
let unlocked = false;
let silent = "";

const audio = () => {
  if (!el) { el = new Audio(); el.preload = "auto"; }
  return el;
};

/** 0.1 s of 8 kHz 8-bit mono silence as a WAV blob URL (no asset needed). */
function silence(): string {
  if (silent) return silent;
  const n = 800, b = new ArrayBuffer(44 + n), v = new DataView(b);
  const s = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, "RIFF"); v.setUint32(4, 36 + n, true); s(8, "WAVE"); s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  s(36, "data"); v.setUint32(40, n, true);
  new Uint8Array(b, 44).fill(128);
  return (silent = URL.createObjectURL(new Blob([b], { type: "audio/wav" })));
}

/** Call from inside a user gesture (tap / click / key). Safe to call often. */
export function unlockVoice() {
  if (unlocked) return;
  unlocked = true;
  const a = audio();
  a.src = silence();
  a.play().then(() => a.pause()).catch(() => { unlocked = false; });
}

/** Play one mp3. Resolves when playback has started; rejects if the browser refuses (caller falls back). */
export async function playVoice(blob: Blob, onEnd: () => void): Promise<void> {
  const a = audio();
  a.pause();
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(blob);
  a.onended = a.onerror = () => onEnd();
  a.src = url;
  await a.play();
}

export function stopVoice() {
  if (el) { el.onended = el.onerror = null; el.pause(); }
}
