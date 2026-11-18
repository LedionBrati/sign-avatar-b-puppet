// Speech -> text without the browser speech engine. The browser engine (lib/speech.ts) ends its session after every
// phrase or silence, and Android Chrome plays a system beep on each (re)start, so a listening screen beeped over and
// over. Here the mic is opened once (lib/mic.ts) and never stops on its own:
//   energy VAD on the shared AnalyserNode -> one MediaRecorder chunk per utterance (pre-roll kept: the recorder runs
//   while silent and is recycled every ~1.5 s) -> ends after 600 ms of silence or at 8 s -> chunks with < 300 ms of
//   voice are dropped -> POST /api/transcribe (parallel) -> onFinal(text) in utterance order.
import { SignApiError, type SignClient } from "@flux/core";
import { acquireMic, releaseMic, type Mic } from "./mic";

export const VAD = {
  frameMs: 30,
  silenceMs: 600, // this much quiet ends an utterance
  maxMs: 8000, // cap per chunk (a new one starts right away if the talking goes on)
  minVoicedMs: 300, // blips shorter than this are never uploaded
  onsetFrames: 2, // consecutive loud frames that start an utterance
  marginDb: 12, // above the tracked noise floor
  minDb: -52, // never trigger below this (a quiet room)
  maxThreshDb: -26, // never require more than this (a noisy room)
  calibrateFrames: 12, // ~360 ms of room noise before the first trigger
  recycleMs: 1500, // a silent recorder is replaced after this long, so the pre-roll stays short
};

export type VadEvent = "start" | "end" | "cap" | null;

/** Pure energy VAD: feed one dBFS reading per frame. Exported for tests. */
export function createVad(o = VAD) {
  let speaking = false, loud = 0, floor = -60, startT = 0, lastVoiceT = 0, voicedMs = 0, frames = 0, minDb = 0;
  const thresh = () => Math.min(o.maxThreshDb, Math.max(o.minDb, floor + o.marginDb));
  return {
    get speaking() { return speaking; },
    get voicedMs() { return voicedMs; },
    get floor() { return floor; },
    thresh,
    step(db: number, t: number): VadEvent {
      if (frames++ < o.calibrateFrames) { floor = frames === 1 ? db : floor + (db - floor) * 0.3; return null; } // learn the room first
      const on = db > thresh();
      if (!speaking) {
        floor += (db - floor) * (db < floor ? 0.3 : 0.02); // drops fast, rises slowly: tracks the room, not the voice
        loud = on ? loud + 1 : 0;
        if (loud >= o.onsetFrames) { speaking = true; startT = t - o.frameMs * loud; lastVoiceT = t; voicedMs = o.frameMs * loud; minDb = db; return "start"; }
        return null;
      }
      if (on) { lastVoiceT = t; voicedMs += o.frameMs; }
      minDb = Math.min(minDb, db);
      if (t - lastVoiceT >= o.silenceMs) { speaking = false; loud = 0; return "end"; }
      if (t - startT >= o.maxMs) {
        // Loud for the whole cap without one dip below the threshold: steady noise (a fan, traffic), not speech, which
        // dips between words. Raise the floor to it so the room stops counting as voice.
        if (minDb > thresh()) { floor = minDb; speaking = false; loud = 0; }
        startT = t; voicedMs = 0; minDb = db;
        return "cap";
      }
      return null;
    },
  };
}

export type CapturePhase = "listening" | "hearing" | "transcribing";
export type CaptureErrorKind = "denied" | "no-mic" | "unavailable" | "network" | "other";
export interface CaptureHandlers {
  onFinal(text: string): void;
  onPhase?(p: CapturePhase): void;
  onError(kind: CaptureErrorKind, raw: string): void;
}

const MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/aac"];
const pickMime = () => (typeof MediaRecorder === "undefined" ? undefined : MIMES.find((m) => MediaRecorder.isTypeSupported?.(m)));
export const captureSupported = () => typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

interface Chunk { rec: MediaRecorder; parts: Blob[]; t0: number; voiced: boolean }

export function createCapture(client: SignClient, h: CaptureHandlers) {
  let active = false, mic: Mic | null = null, timer = 0, cur: Chunk | null = null, mime: string | undefined;
  let seq = 0, emitted = 0, pending = 0, phase: CapturePhase | null = null;
  const done = new Map<number, string>();
  const vad = createVad();

  const setPhase = () => {
    const p: CapturePhase = vad.speaking ? "hearing" : pending > 0 ? "transcribing" : "listening";
    if (p !== phase) { phase = p; h.onPhase?.(p); }
  };

  function newChunk(voiced: boolean): Chunk | null {
    if (!mic) return null;
    let rec: MediaRecorder;
    try { rec = new MediaRecorder(mic.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32_000 }); } catch { return null; }
    const c: Chunk = { rec, parts: [], t0: performance.now(), voiced };
    rec.ondataavailable = (e) => { if (e.data.size) c.parts.push(e.data); };
    rec.start();
    return c;
  }
  function drop(c: Chunk | null) { if (!c) return; c.rec.ondataavailable = null; try { c.rec.stop(); } catch { /* already stopped */ } }
  function finish(c: Chunk, voicedMs: number) {
    const ms = performance.now() - c.t0;
    c.rec.onstop = () => {
      if (!active || voicedMs < VAD.minVoicedMs || !c.parts.length) return;
      void upload(new Blob(c.parts, { type: c.rec.mimeType || mime || "audio/webm" }), ms);
    };
    try { c.rec.stop(); } catch { /* already stopped */ }
  }

  async function upload(blob: Blob, ms: number) {
    const id = ++seq;
    pending++;
    setPhase();
    let text = "";
    try {
      text = (await client.transcribe(blob, { ms })).text ?? "";
    } catch (e) {
      if (e instanceof SignApiError && (e.code === "transcribe_off" || e.status === 404)) { stop(); h.onError("unavailable", e.message); }
      else if (e instanceof SignApiError) console.warn("[flux] transcribe", e.code, e.message);
      else h.onError("network", String((e as Error).message ?? e));
    }
    pending--;
    done.set(id, text.trim());
    while (done.has(emitted + 1)) {
      const t = done.get(++emitted)!;
      done.delete(emitted);
      if (t && active) h.onFinal(t);
    }
    if (active) setPhase();
  }

  function tick() {
    if (!active || !mic) return;
    const t = performance.now();
    const voicedBefore = vad.voicedMs;
    const ev = vad.step(mic.rmsDb(), t);
    if (ev === "start") { if (cur) cur.voiced = true; else cur = newChunk(true); }
    else if (ev === "end" || ev === "cap") {
      const old = cur;
      cur = newChunk(vad.speaking); // the next recorder starts before the old one stops: no gap
      if (old) finish(old, ev === "cap" ? voicedBefore : vad.voicedMs);
    } else if (!vad.speaking && cur && !cur.voiced && t - cur.t0 > VAD.recycleMs) {
      const old = cur;
      cur = newChunk(false);
      drop(old);
    } else if (!cur) cur = newChunk(vad.speaking);
    setPhase();
  }

  return {
    async start() {
      if (active) return;
      active = true;
      try {
        mic = await acquireMic();
      } catch (e) {
        active = false;
        const name = (e as DOMException).name;
        h.onError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "no-mic" : "other", String((e as Error).message ?? name));
        return;
      }
      if (!active) { releaseMic(); mic = null; return; }
      mime = pickMime();
      cur = newChunk(false);
      timer = window.setInterval(tick, VAD.frameMs);
      setPhase();
    },
    stop,
    get active() { return active; },
  };

  function stop() {
    if (!active && !mic) return;
    active = false;
    clearInterval(timer);
    drop(cur);
    cur = null;
    if (mic) { mic = null; releaseMic(); }
    phase = null;
  }
}
