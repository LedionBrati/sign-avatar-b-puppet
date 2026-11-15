// One shared microphone for the whole page: the listener (capture.ts) and the level meter (meter.ts) read the same
// stream and the same AnalyserNode, so the mic is opened once. Reference counted: the last release() stops it.
// The graph is source -> analyser only. Nothing is ever connected to ctx.destination, so the page never plays the
// mic back (no echo, no sound on open).
export interface Mic {
  stream: MediaStream;
  ctx: AudioContext;
  /** RMS level of the latest ~20 ms, in dBFS (about -100 silence .. 0 full scale). */
  rmsDb(): number;
}

let shared: { p: Promise<Mic>; refs: number } | null = null;

export const micHeld = () => shared !== null;

export function acquireMic(): Promise<Mic> {
  if (shared) { shared.refs++; return shared.p; }
  const p = open();
  const entry = { p, refs: 1 };
  shared = entry;
  p.catch(() => { if (shared === entry) shared = null; });
  return p;
}

export function releaseMic() {
  if (!shared) return;
  if (--shared.refs > 0) return;
  const p = shared.p;
  shared = null;
  void p.then((m) => { m.stream.getTracks().forEach((t) => t.stop()); void m.ctx.close().catch(() => {}); }).catch(() => {});
}

async function open(): Promise<Mic> {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !AC) throw Object.assign(new Error("no microphone API"), { name: "NotSupportedError" });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AC();
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  an.smoothingTimeConstant = 0;
  ctx.createMediaStreamSource(stream).connect(an); // analyser only: never to ctx.destination
  // Mobile browsers may start the context suspended when the tap that opened the screen has expired: resume on the
  // next touch (the analyser reads zeros until then).
  const resume = () => { void ctx.resume().catch(() => {}); };
  resume();
  if (ctx.state !== "running") {
    const once = () => { resume(); if (ctx.state === "running") removeEventListener("pointerdown", once); };
    addEventListener("pointerdown", once);
  }
  const buf = new Float32Array(an.fftSize);
  return {
    stream, ctx,
    rmsDb() {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
      return 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-5);
    },
  };
}
