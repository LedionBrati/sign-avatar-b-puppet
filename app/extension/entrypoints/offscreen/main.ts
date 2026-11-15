// Offscreen document (reason USER_MEDIA): turns a tabCapture stream id into text.
//
//   tab audio ─► AudioContext ─► speakers (the tab stays audible: capturing a tab mutes it otherwise)
//             └► AnalyserNode (level, ~silence detection) + MediaRecorder (audio/webm opus)
//   chunks of 2-5 s, cut at a short silence when possible (a hard cut overlaps the next chunk by 0.4 s),
//   silent chunks skipped ─► POST {apiUrl}/api/transcribe ─► text (in order) ─► background ─► the tab's signer.
import { ROUTES, type TranscribeResponse } from "@signlayer/core";
import { browser } from "wxt/browser";
import type { ToBackground } from "@/lib/messages";

type Start = { target: "offscreen"; type: "start"; streamId: string; tabId: number; apiUrl: string };
type Stop = { target: "offscreen"; type: "stop" };

const MIN_MS = 2000, MAX_MS = 5000, SILENCE_MS = 280, OVERLAP_MS = 400, MIN_VOICED_MS = 250;
const send = (m: ToBackground) => browser.runtime.sendMessage(m).catch(() => {});

let run: Session | null = null;
/** Diagnostics read by scripts/verify-youtube.mjs: per-chunk length, size, round-trip latency, text (no audio unless keep). */
const dbg = { chunks: [] as { ms: number; bytes: number; latency_ms: number; text: string }[], keep: false, blobs: [] as { ms: number; bytes: number; b64: string }[] };
(globalThis as { __slTabAudio?: typeof dbg }).__slTabAudio = dbg;

browser.runtime.onMessage.addListener((raw: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
  const m = raw as Start | Stop;
  if (m?.target !== "offscreen") return;
  if (m.type === "start") {
    run?.stop("restart");
    run = new Session(m);
    run.start().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (m.type === "stop") {
    run?.stop("off");
    run = null;
    sendResponse({ ok: true });
  }
});

interface Seg { rec: MediaRecorder; started: number; voicedMs: number; parts: Blob[] }

class Session {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private cur: Seg | null = null;
  private timer = 0;
  private silenceRun = 0;
  private noise = 0.004;
  private seq = 0;
  private emitted = 0;
  private done = new Map<number, string>();
  private prevText = "";
  private lastLevelSent = 0;
  private stopped = false;
  private mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";

  constructor(private o: Start) {}

  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: this.o.streamId } } as unknown as MediaTrackConstraints,
        video: false,
      });
    } catch (e) {
      this.state("error", `Can't capture this tab's audio (${e instanceof Error ? e.name : e})`);
      throw e;
    }
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    src.connect(this.ctx.destination);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.stream.getAudioTracks()[0]?.addEventListener("ended", () => this.stop("off"));
    this.cur = this.newSeg();
    this.timer = self.setInterval(() => this.tick(), 50);
    this.state("listening");
  }

  private state(state: "listening" | "error" | "off", detail?: string, level?: number) {
    send({ type: "tab-audio-state", tabId: this.o.tabId, state, detail, level });
  }

  private newSeg(): Seg {
    const rec = new MediaRecorder(this.stream!, { mimeType: this.mime, audioBitsPerSecond: 48_000 });
    const seg: Seg = { rec, started: performance.now(), voicedMs: 0, parts: [] };
    rec.ondataavailable = (e) => e.data.size && seg.parts.push(e.data);
    rec.start();
    return seg;
  }

  private rms() {
    const a = this.analyser!;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    return Math.sqrt(sum / buf.length);
  }

  private tick() {
    if (!this.cur || this.stopped) return;
    const level = this.rms();
    // Slow-moving noise floor; "voiced" = clearly above it.
    this.noise = level < this.noise ? this.noise * 0.9 + level * 0.1 : this.noise * 0.999 + level * 0.001;
    const voiced = level > Math.max(0.012, this.noise * 2.5);
    if (voiced) { this.cur.voicedMs += 50; this.silenceRun = 0; } else this.silenceRun += 50;
    const now = performance.now();
    if (now - this.lastLevelSent > 140) {
      this.lastLevelSent = now;
      this.state("listening", undefined, Math.min(1, level * 6));
    }
    const age = now - this.cur.started;
    if (age >= MIN_MS && this.silenceRun >= SILENCE_MS) this.cut(false);
    else if (age >= MAX_MS) this.cut(true);
  }

  /** End the current chunk and start the next. A hard cut (mid-speech) starts the next recorder early, so they overlap. */
  private cut(hard: boolean) {
    const old = this.cur!;
    const next = this.newSeg();
    this.cur = next;
    const finish = () => {
      old.rec.onstop = () => this.upload(old, performance.now() - old.started);
      old.rec.stop();
    };
    if (hard) setTimeout(finish, OVERLAP_MS);
    else finish();
  }

  private async upload(seg: Seg, ms: number) {
    if (this.stopped || seg.voicedMs < MIN_VOICED_MS) return;
    const id = ++this.seq;
    const blob = new Blob(seg.parts, { type: "audio/webm" });
    const t0 = performance.now();
    if (dbg.keep) blob.arrayBuffer().then((b) => dbg.blobs.push({ ms: Math.round(ms), bytes: b.byteLength, b64: btoa(String.fromCharCode(...new Uint8Array(b))) }));
    let text = "";
    try {
      // No "prev" prompt: on a chunk that is mostly overlap or silence the models echo the prompt back.
      const res = await fetch(`${this.o.apiUrl.replace(/\/$/, "")}${ROUTES.transcribe}?lang=en`, {
        method: "POST", body: blob, headers: { "content-type": "audio/webm", "x-audio-ms": String(Math.min(30000, Math.round(ms))) },
      });
      const body = (await res.json().catch(() => null)) as (TranscribeResponse & { error?: { code: string; message: string } }) | null;
      if (!res.ok) {
        const code = body?.error?.code ?? `http_${res.status}`;
        if (code === "transcribe_off") this.state("error", "Speech-to-text is off on the SIGNLAYER server (it needs an OpenAI key)");
        else console.warn("[signlayer] transcribe", code, body?.error?.message);
      } else text = body?.text ?? "";
    } catch (e) {
      console.warn("[signlayer] transcribe failed", e);
      this.state("error", "Can't reach the SIGNLAYER server for speech-to-text");
    }
    this.done.set(id, text);
    const latency = Math.round(performance.now() - t0);
    dbg.chunks.push({ ms: Math.round(ms), bytes: blob.size, latency_ms: latency, text });
    if (dbg.chunks.length > 50) dbg.chunks.shift();
    // Emit in order, dropping words the overlap repeated.
    while (this.done.has(this.emitted + 1)) {
      const t = dedupe(this.prevText, this.done.get(++this.emitted)!);
      this.done.delete(this.emitted);
      if (!t) continue;
      this.prevText = `${this.prevText} ${t}`.trim().split(" ").slice(-60).join(" ");
      if (!this.stopped) send({ type: "tab-audio-text", tabId: this.o.tabId, text: t, latency_ms: latency });
    }
  }

  stop(why: "off" | "restart") {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    try { if (this.cur?.rec.state !== "inactive") this.cur?.rec.stop(); } catch { /* already stopped */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    if (why === "off") this.state("off");
  }
}

const n = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
/** Drop leading words of `next` that repeat the last words of `prev` (chunk overlap); "" if `next` was already said. */
export function dedupe(prev: string, next: string) {
  const p = prev.split(" ").filter(Boolean).map(n), w = next.split(" ").filter(Boolean);
  const wn = w.map(n).filter(Boolean);
  if (wn.length && ` ${p.slice(-40).join(" ")} `.includes(` ${wn.join(" ")} `)) return "";
  for (let k = Math.min(4, p.length, w.length); k > 0; k--) {
    if (w.slice(0, k).map(n).join(" ") === p.slice(-k).join(" ")) return w.slice(k).join(" ");
  }
  return next.trim();
}
