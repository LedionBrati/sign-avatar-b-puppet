// Sign -> speak, continuous: the front camera, MediaPipe Holistic landmarks, always reading while the camera is on
// (no tap per sign): every segment (hands move -> rest/leave/still) goes to POST /api/recognize; top-1 is appended
// (top-3 chips to correct it). The sentence (composeSentence, no model call) is spoken automatically once it has
// 2 signs and the hands have rested ~1.2 s, or as soon as it has 3; then a fresh sentence starts. Pause/Resume stops
// reading; Undo/Clear/edit + Speak stay available.
// "#/sign?embed=1" is the same screen for the phone app's WebView: results also go to window.ReactNativeWebView.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignApiError, composeSentence, createSignClient, labelText, type RecognizeMode, type RecognizeResponse } from "@signlayer/core";
import { apiBase, apiLabel } from "../config";
import { ClockIcon, CloseIcon, GridIcon, HandIcon, PauseIcon, SpeakerIcon, UndoIcon } from "../components/Icons";
import { Island, type IslandTone } from "../components/Island";
import { Segmented } from "../components/Segmented";
import { createTracker, drawOverlay, type Tracker } from "../lib/holistic";
import { createSegmenter, type SegState, type SegmentDone } from "../lib/segmenter";
import { SIGN_VOCAB } from "../lib/vocab";

type Option = RecognizeResponse["options"][number];
interface Entry { label: string; options?: Option[]; sel?: number }
type Cam = "starting" | "ready" | "denied" | "nocam" | "error";

const LOW = 0.35; // below this the top-3 chips get a "not sure" hint
const QUIET_MS = 1200; // hands rested/still this long after >= 2 signs -> speak
const MAX_SIGNS = 3; // a sentence this long is spoken right away
const END_LAG_MS = 400; // the segmenter needs ~this much stillness before it ends a segment
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const wordOf = (l: string) => (l.startsWith("#") ? cap(l.slice(1).toLowerCase()) : labelText(l));

declare global { interface Window { ReactNativeWebView?: { postMessage(s: string): void }; __sl?: Record<string, unknown> } }
/** Embed mode: the phone app's WebView gets a JSON string; its web/iframe fallback gets the object on window "message". */
const post = (msg: { type: "sentence" | "speak"; text: string }) => {
  try { window.ReactNativeWebView?.postMessage(JSON.stringify(msg)); } catch { /* not in a WebView */ }
  try { if (window.parent !== window) window.parent.postMessage(msg, "*"); } catch { /* cross-origin parent gone */ }
};

export function SignToSpeak({ embed, onHome }: { embed: boolean; onHome(): void }) {
  const client = useMemo(() => createSignClient(apiBase(), { timeoutMs: 12_000 }), []);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tracker = useRef<Tracker | null>(null);
  const alive = useRef(true);
  const modeRef = useRef<RecognizeMode>("sign");

  const [cam, setCam] = useState<Cam>("starting");
  const [camMsg, setCamMsg] = useState("");
  const [track, setTrack] = useState<"loading" | "ready" | "error">("loading");
  const [fps, setFps] = useState(0);
  const [hands, setHands] = useState(false);
  const [seg, setSeg] = useState<SegState>("idle");
  const [pending, setPending] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [segEndAt, setSegEndAt] = useState(0);
  const [mode, setMode] = useState<RecognizeMode>("sign");
  const [items, setItems] = useState<Entry[]>([]);
  const [edit, setEdit] = useState<{ text: string; at: number } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [sheet, setSheet] = useState<"signs" | "history" | null>(null);
  modeRef.current = mode;

  // ── Recognize segments: parallel requests, results appended in segment order; a Clear/Pause/spoken sentence
  // makes the still-pending ones stale (epoch) so they never land in the next sentence. ──
  const order = useRef({ seq: 0, next: 1, epoch: 0, done: new Map<number, { epoch: number; entry: Entry | null }>() });
  const flush = useCallback(() => {
    const o = order.current;
    const add: Entry[] = [];
    while (o.done.has(o.next)) {
      const r = o.done.get(o.next)!;
      o.done.delete(o.next++);
      if (r.entry && r.epoch === o.epoch) add.push(r.entry);
    }
    if (add.length) setItems((xs) => [...xs, ...add]);
  }, []);

  const onSegment = useCallback(async (s: SegmentDone) => {
    setSegEndAt(performance.now());
    if (!s.count) return; // a twitch: keep reading
    const o = order.current;
    const id = ++o.seq, epoch = o.epoch;
    let entry: Entry | null = null;
    setPending((n) => n + 1);
    const m = modeRef.current;
    const t0 = performance.now();
    try {
      const r = await client.recognize(m, s.frames);
      if (!alive.current) return;
      window.__sl = { ...window.__sl, last: r, frames: s.count, segMs: Math.round(s.ms), reason: s.reason, rtMs: Math.round(performance.now() - t0), recognized: ((window.__sl?.recognized as number) ?? 0) + 1 };
      setBanner(null);
      if (m === "spell") {
        const word = (r.text ?? "").replace(/[^A-Za-z' -]/g, "").trim();
        if (word) entry = { label: `#${word.toUpperCase()}` };
      } else {
        const options = [...r.options].sort((a, b) => b.confidence - a.confidence);
        if (options.length) {
          entry = { label: options[0]!.label, options, sel: 0 };
          if (epoch === o.epoch) setHint(options[0]!.confidence < LOW ? "Not sure about that one. Tap the right word below." : null);
        }
      }
    } catch (e) {
      if (!alive.current) return;
      const err = e as Error;
      if (err instanceof SignApiError && err.status === 503) setBanner("The sign recognizer is offline (503). Start app/recognizer, then try again.");
      else if (err instanceof SignApiError && err.status === 404) setBanner(`This server has no sign recognizer yet (${apiLabel()}/api/recognize is 404). Try npm run dev:mock.`);
      else if (err instanceof SignApiError) setBanner(`The recognizer failed: ${err.message}`);
      else setBanner(`Can't reach the server at ${apiLabel()}. Is it running? (${err.message})`);
    } finally {
      if (alive.current) {
        o.done.set(id, { epoch, entry });
        flush();
        setPending((n) => n - 1);
      }
    }
  }, [client, flush]);

  const onSegmentRef = useRef(onSegment);
  onSegmentRef.current = onSegment;
  const segRef = useRef<ReturnType<typeof createSegmenter> | null>(null);
  if (!segRef.current) segRef.current = createSegmenter((s) => void onSegmentRef.current(s), (s) => alive.current && setSeg(s));

  // ── Camera ──
  const startCam = useCallback(async () => {
    setCam("starting");
    setCamMsg("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } });
      if (!alive.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});
      setCam("ready");
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === "NotAllowedError" || name === "SecurityError") { setCam("denied"); setCamMsg("Camera access is blocked. Allow it from the icon in the address bar (or site settings), then tap Retry."); }
      else if (name === "NotFoundError" || name === "OverconstrainedError") { setCam("nocam"); setCamMsg("No camera found. Plug one in, or open this on your phone."); }
      else { setCam("error"); setCamMsg(`The camera didn't start (${(e as Error).message || name}).`); }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void startCam();
    createTracker().then((t) => {
      if (!alive.current) { t.close(); return; }
      tracker.current = t;
      window.__sl = { ...window.__sl, delegate: t.delegate };
      setTrack("ready");
    }).catch((e) => { if (alive.current) { setTrack("error"); setBanner(`Hand tracking didn't load (${(e as Error).message}). Check the connection and reload.`); } });
    client.health().then((h) => { if (alive.current && h.recognizer === "down") setBanner("The sign recognizer is offline. Start app/recognizer; signing won't work until then."); }).catch(() => {});
    return () => {
      alive.current = false;
      const s = video.current?.srcObject as MediaStream | null;
      s?.getTracks().forEach((t) => t.stop());
      tracker.current?.close();
      tracker.current = null;
    };
  }, [client, startCam]);

  // ── Per-frame loop: detect, draw, segment, fps ──
  useEffect(() => {
    if (cam !== "ready" || track !== "ready") return;
    const v = video.current!, c = canvas.current!, ctx = c.getContext("2d")!;
    let stop = false, handle = 0, lastT = -1, n = 0, dms = 0, win = performance.now(), sawHands = false;
    const rvfc = "requestVideoFrameCallback" in v;
    const next = () => { handle = rvfc ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(() => tick()); };
    const tick = () => {
      if (stop || !alive.current) return;
      const t = tracker.current;
      if (t && v.readyState >= 2 && v.currentTime !== lastT) {
        lastT = v.currentTime;
        if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
        const now = performance.now();
        const f = t.detect(v, now);
        dms += performance.now() - now;
        drawOverlay(ctx, f, t.connections);
        segRef.current!.push(f, performance.now());
        const h = Boolean(f.leftHand?.length || f.rightHand?.length);
        if (h !== sawHands) { sawHands = h; setHands(h); }
        n++;
        if (now - win >= 1000) { const r = (n * 1000) / (now - win); setFps(r); window.__sl = { ...window.__sl, fps: +r.toFixed(1), detectMs: Math.round(dms / n) }; n = 0; dms = 0; win = now; }
      }
      next();
    };
    next();
    return () => { stop = true; if (rvfc) v.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle); };
  }, [cam, track]);

  // ── Camera on => always reading (until Pause) ──
  useEffect(() => {
    const sg = segRef.current!;
    if (cam === "ready" && track === "ready" && !paused) { if (sg.state === "idle") sg.arm(); }
    else sg.cancel();
  }, [cam, track, paused]);

  // ── Sentence ──
  const sentence = useMemo(() => {
    if (!edit) return composeSentence(items.map((x) => x.label));
    const rest = items.slice(edit.at).map((x) => wordOf(x.label));
    if (!rest.length) return edit.text;
    const base = edit.text.trim().replace(/[.?!]+$/, "");
    return base ? `${base} ${rest.join(" ")}.` : composeSentence(items.slice(edit.at).map((x) => x.label));
  }, [items, edit]);

  useEffect(() => { if (embed) post({ type: "sentence", text: sentence }); }, [sentence, embed]);

  const choose = (i: number) => {
    setItems((xs) => {
      const last = xs[xs.length - 1];
      if (!last?.options?.[i]) return xs;
      return [...xs.slice(0, -1), { ...last, label: last.options[i]!.label, sel: i }];
    });
    setHint(null);
  };
  const undo = () => {
    setHint(null);
    const n = items.length - 1;
    if (n < 0 || (edit && n < edit.at)) setEdit(null); // nothing signed since the edit: undo the edit
    if (n >= 0) setItems(items.slice(0, n));
  };
  const fresh = () => { order.current.epoch++; setItems([]); setEdit(null); setHint(null); };
  const clear = fresh;
  const lastSpoken = useRef("");
  const speakTimer = useRef(0);
  const speakText = useCallback((text: string) => {
    if (embed) post({ type: "speak", text });
    else if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      const voice = speechSynthesis.getVoices().find((v) => v.lang === "en-US");
      if (voice) u.voice = voice;
      u.onend = u.onerror = () => { if (alive.current) setSpeaking((x) => (x === text ? null : x)); };
      speechSynthesis.speak(u);
    }
    setSpeaking(text);
    clearTimeout(speakTimer.current);
    speakTimer.current = window.setTimeout(() => alive.current && setSpeaking((x) => (x === text ? null : x)), 1500 + text.length * 70);
    setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 8));
  }, [embed]);
  /** Speak the sentence and start a fresh one. The same text twice in a row is not spoken again. */
  const speak = () => {
    const text = sentence.trim();
    if (!text) return;
    if (text !== lastSpoken.current) { lastSpoken.current = text; speakText(text); }
    fresh();
  };
  const speakRef = useRef(speak);
  speakRef.current = speak;

  // Auto-speak: 3 signs -> now; 2+ signs -> once the hands have rested QUIET_MS (and nothing is still being read).
  useEffect(() => {
    if (paused || editing || items.length < 2) return;
    if (items.length >= MAX_SIGNS) { speakRef.current(); return; }
    if (seg === "recording" || pending > 0) return;
    const wait = Math.max(0, QUIET_MS - END_LAG_MS - (performance.now() - segEndAt));
    const t = setTimeout(() => speakRef.current(), wait);
    return () => clearTimeout(t);
  }, [items, seg, pending, paused, editing, segEndAt]);

  const tap = () => {
    setHint(null);
    setPaused((p) => !p);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "Escape" && !embed) onHome();
      if (e.key === " ") { e.preventDefault(); tap(); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const last = items[items.length - 1];
  const cands = last?.options?.slice(0, 3) ?? [];
  const ready = cam === "ready" && track === "ready";
  const busy = pending > 0;
  const camOff = !ready ? (cam === "starting" || track === "loading" ? "Starting camera" : "Camera off") : null;
  const tone: IslandTone = speaking ? "sign" : camOff ? (cam === "starting" || track === "loading" ? "busy" : "warn") : paused ? "idle" : seg === "recording" ? "rec" : busy ? "busy" : "live";
  const island = speaking ? "Speaking:" : camOff ?? (paused ? "Paused" : seg === "recording" ? "Signing…" : "Reading");
  const status = cam === "denied" || cam === "nocam" || cam === "error" ? "Camera unavailable" : cam === "starting" ? "Starting the camera…" : track === "loading" ? "Loading hand tracking…" : track === "error" ? "Hand tracking unavailable" : paused ? "Paused. Tap Resume to keep reading." : seg === "recording" ? "Signing… rest your hands to finish a word" : busy ? "Reading…" : hands ? "Hands found. Sign a word." : "Raise your hands and sign";
  const btn = paused ? "Resume" : "Pause";
  return (
    <div className={`screen signsp${embed ? " embed" : ""}`}>
      <header className="topbar">
        {embed ? <span /> : <button className="circbtn" aria-label="Close" title="Close" onClick={onHome}><CloseIcon /></button>}
        <Island tone={tone} label={island} detail={speaking ?? undefined} className={seg === "recording" && !speaking ? "rec" : ""} />
        <button className="circbtn" aria-label="Signs I know" title={`${SIGN_VOCAB.length} signs I know`} onClick={() => setSheet("signs")}><GridIcon /></button>
      </header>

      {camMsg ? (
        <div className="banner" role="alert"><span>{camMsg}</span>{cam === "denied" || cam === "error" ? <button className="retry" onClick={startCam}>Retry</button> : null}</div>
      ) : null}
      {banner ? <div className="banner" role="alert"><span>{banner}</span></div> : null}

      <section className="stagewrap">
        <div className={`camcard${seg === "recording" ? " rec" : ""}`} title={ready ? `${fps.toFixed(0)} fps · MediaPipe on ${tracker.current?.delegate ?? "?"}` : undefined}>
          <video ref={video} className="cam" muted playsInline autoPlay />
          <canvas ref={canvas} className="cam overlay" />
          <span className={`camstatus${hands ? " on" : ""}`} aria-live="polite">{status}</span>
        </div>
      </section>

      <section className="sentzone">
        <div className="cands" aria-label="Did you sign">
          {cands.map((o, i) => (
            <button key={o.label + i} className={`cand${last?.sel === i ? " on" : ""}`} onClick={() => choose(i)}>
              {o.text || labelText(o.label)}<em>{Math.round(o.confidence * 100)}%</em>
            </button>
          ))}
          {!cands.length ? <p className="candhint">{mode === "spell" ? "Fingerspell a name, letter by letter." : `Just sign: 2–3 words are spoken automatically · ${SIGN_VOCAB.length} signs`}</p> : null}
        </div>
        <div className="sentence">
          <textarea aria-label="Sentence to speak" rows={2} spellCheck={false} placeholder="Your sentence" value={sentence}
            onChange={(e) => setEdit({ text: e.target.value, at: items.length })} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} />
          <div className="caprow">
            <button className="capbtn" onClick={undo} disabled={!items.length && !edit}><UndoIcon />Undo</button>
            <button className="capbtn" onClick={clear} disabled={!items.length && !edit}>Clear</button>
            <button className="capbtn speak" onClick={speak} disabled={!sentence.trim()}><SpeakerIcon />Speak</button>
          </div>
        </div>
        <p className="hint signhint" aria-live="polite">{hint ?? ""}</p>
      </section>

      <footer className="controls">
        <Segmented<RecognizeMode> label="Mode" value={mode} onChange={setMode} options={[{ value: "sign", label: "Sign" }, { value: "spell", label: "Spell" }]} />
        <button id="signbtn" className={`shutter${paused ? "" : " reading"}`} onClick={tap} disabled={!ready} aria-label={btn} aria-pressed={!paused} title={`${btn} (Space)`}>
          <span className="core">{paused ? <HandIcon /> : <PauseIcon />}</span>
          <span className="sr-only">{btn}</span>
        </button>
        <button className="circbtn lg" aria-label={`Said${history.length ? ` (${history.length})` : ""}`} title="Said" onClick={() => setSheet("history")} disabled={!history.length}><ClockIcon /></button>
      </footer>

      {sheet ? (
        <div className="sheet-back" onClick={() => setSheet(null)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label={sheet === "signs" ? "Signs I know" : "Said"} onClick={(e) => e.stopPropagation()}>
            <div className="grabber" aria-hidden="true" />
            <header className="sheet-head">
              <h2>{sheet === "signs" ? `${SIGN_VOCAB.length} signs` : "Said"}</h2>
              <button className="textbtn" onClick={() => setSheet(null)} autoFocus>Done</button>
            </header>
            {sheet === "signs" ? (
              <>
                <p className="lede">Single ASL signs from the Kaggle GISLR set, one at a time. Anything else comes out as the closest of these, so check the guesses. For names, use Spell.</p>
                <div className="group vocab">{[...SIGN_VOCAB].sort((a, b) => labelText(a).localeCompare(labelText(b))).map((l) => <span key={l}>{labelText(l)}</span>)}</div>
              </>
            ) : (
              <ul className="group said">{history.map((h, i) => <li key={i}><span>{h}</span><button className="btn" onClick={() => { setEdit({ text: h, at: items.length }); setSheet(null); }}>Use</button></li>)}</ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
