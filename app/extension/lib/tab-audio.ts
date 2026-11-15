// Tab audio, captured inside the side panel itself (no offscreen document needed):
//
//   tabCapture.getMediaStreamId({ targetTabId })  (allowed because the toolbar click invoked the extension on that tab)
//   getUserMedia({ chromeMediaSource: "tab" }) ─► AudioContext ─► speakers  (capturing a tab mutes it otherwise)
//                                             └► AnalyserNode (level, silence) + MediaRecorder (audio/webm opus)
//   chunks of 2-4 s, cut at a short silence when possible (a hard cut overlaps the next chunk by 0.4 s),
//   silent chunks skipped ─► POST {apiUrl}/api/transcribe ─► text, in order, overlap words dropped.
import { browser } from "wxt/browser";
import { ROUTES, type TranscribeResponse } from "@signlayer/core";

const MIN_MS = 2000, MAX_MS = 4000, SILENCE_MS = 280, OVERLAP_MS = 400, MIN_VOICED_MS = 250, NO_AUDIO_MS = 6000;

export interface TabAudioHandlers {
  onText(text: string): void;
  onLevel(level: number): void;
  /** Soft hint (still capturing), e.g. nothing audible yet. "" clears it. */
  onHint(text: string): void;
  /** Fatal: capture stopped. */
  onError(text: string): void;
}

/** Diagnostics (read by scripts/verify.mjs): per-chunk length, size, round trip, text. */
export const tabDebug = { chunks: [] as { ms: number; bytes: number; latency_ms: number; text: string }[] };
(globalThis as { __slTab?: typeof tabDebug }).__slTab = tabDebug;

/** Plain words for the errors Chrome throws at getMediaStreamId / getUserMedia. */
export function captureError(e: unknown) {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/chrome pages|cannot be captured|chrome:\/\//i.test(m)) return "Chrome's own pages can't be captured. Switch to a tab that plays audio.";
  if (/invoked|activeTab/i.test(m)) return "Click the SIGNLAYER icon while on the tab you want to hear, then press Start.";
  if (/active stream/i.test(m)) return "This tab is already being captured. Stop the other capture and try again.";
  if (/NotAllowed|Permission|denied/i.test(m)) return "Chrome refused to share this tab's audio.";
  return `Can't capture this tab's audio (${m.slice(0, 80)})`;
}

interface Seg { rec: MediaRecorder; started: number; voicedMs: number; parts: Blob[] }

export class TabAudio {
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
  private startedAt = 0;
  private everVoiced = false;
  private stopped = false;
  private mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";

  constructor(private apiUrl: string, private h: TabAudioHandlers) {}

  /** Call from the Start click. Throws a plain-language Error when Chrome refuses. */
  async start(tabId: number) {
    // Created inside the click, so it may start playing without another gesture.
    this.ctx = new AudioContext();
    try {
      const id = await browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } } as unknown as MediaTrackConstraints,
        video: false,
      });
    } catch (e) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      throw new Error(captureError(e));
    }
    if (this.stopped) { this.stream.getTracks().forEach((t) => t.stop()); return; }
    await this.ctx.resume().catch(() => {});
    const src = this.ctx.createMediaStreamSource(this.stream);
    src.connect(this.ctx.destination); // keep the tab audible
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (!this.stopped) { this.stop(); this.h.onError("The tab stopped sharing audio (closed or navigated away)."); }
    });
    this.startedAt = performance.now();
    this.cur = this.newSeg();
    this.timer = self.setInterval(() => this.tick(), 50);
  }

  private newSeg(): Seg {
    const rec = new MediaRecorder(this.stream!, { mimeType: this.mime, audioBitsPerSecond: 48_000 });
    const seg: Seg = { rec, started: performance.now(), voicedMs: 0, parts: [] };
    rec.ondataavailable = (e) => { if (e.data.size) seg.parts.push(e.data); };
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
    if (voiced) {
      this.cur.voicedMs += 50;
      this.silenceRun = 0;
      if (!this.everVoiced) { this.everVoiced = true; this.h.onHint(""); }
    } else this.silenceRun += 50;
    this.h.onLevel(Math.min(1, level * 6));
    const now = performance.now();
    if (!this.everVoiced && now - this.startedAt > NO_AUDIO_MS) {
      this.startedAt = now;
      this.h.onHint("No sound from this tab yet. Press play on the video or call.");
    }
    const age = now - this.cur.started;
    if (age >= MIN_MS && this.silenceRun >= SILENCE_MS) this.cut(false);
    else if (age >= MAX_MS) this.cut(true);
  }

  /** End the current chunk and start the next. A hard cut (mid-speech) starts the next recorder early, so they overlap. */
  private cut(hard: boolean) {
    const old = this.cur!;
    this.cur = this.newSeg();
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
    let text = "";
    try {
      const res = await fetch(`${this.apiUrl.replace(/\/$/, "")}${ROUTES.transcribe}?lang=en`, {
        method: "POST", body: blob, headers: { "content-type": "audio/webm", "x-audio-ms": String(Math.min(30000, Math.round(ms))) },
      });
      const body = (await res.json().catch(() => null)) as (TranscribeResponse & { error?: { code: string; message: string } }) | null;
      if (!res.ok) {
        const code = body?.error?.code ?? `http_${res.status}`;
        if (code === "transcribe_off") { this.stop(); this.h.onError("Speech-to-text is off on the SIGNLAYER server (it needs an OpenAI key)."); }
        else console.warn("[signlayer] transcribe", code, body?.error?.message);
      } else text = body?.text ?? "";
    } catch (e) {
      console.warn("[signlayer] transcribe failed", e);
      this.h.onHint("Can't reach the SIGNLAYER server for speech-to-text.");
    }
    this.done.set(id, text);
    tabDebug.chunks.push({ ms: Math.round(ms), bytes: blob.size, latency_ms: Math.round(performance.now() - t0), text });
    if (tabDebug.chunks.length > 50) tabDebug.chunks.shift();
    // Emit in order, dropping words the overlap repeated.
    while (this.done.has(this.emitted + 1)) {
      const t = dedupe(this.prevText, this.done.get(++this.emitted)!);
      this.done.delete(this.emitted);
      if (!t) continue;
      this.prevText = `${this.prevText} ${t}`.trim().split(" ").slice(-60).join(" ");
      if (!this.stopped) this.h.onText(t);
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    try { if (this.cur && this.cur.rec.state !== "inactive") this.cur.rec.stop(); } catch { /* already stopped */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.h.onLevel(0);
  }
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
/** Drop leading words of `next` that repeat the last words of `prev` (chunk overlap); "" if `next` was already said. */
export function dedupe(prev: string, next: string) {
  const p = prev.split(" ").filter(Boolean).map(norm), w = next.split(" ").filter(Boolean);
  const wn = w.map(norm).filter(Boolean);
  if (wn.length && ` ${p.slice(-40).join(" ")} `.includes(` ${wn.join(" ")} `)) return "";
  for (let k = Math.min(4, p.length, w.length); k > 0; k--) {
    if (w.slice(0, k).map(norm).join(" ") === p.slice(-k).join(" ")) return w.slice(k).join(" ");
  }
  return next.trim();
}
