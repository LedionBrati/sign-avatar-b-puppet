// Sign -> speak: the front camera, MediaPipe Holistic landmarks, one sign per tap of "Sign", POST /api/recognize,
// top-3 choices, a sentence composed without any model call (composeSentence), editable, then spoken out loud.
// "#/sign?embed=1" is the same screen for the phone app's WebView: results also go to window.ReactNativeWebView.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignApiError, composeSentence, createSignClient, labelText, type RecognizeMode, type RecognizeResponse } from "@signlayer/core";
import { apiBase, apiLabel } from "../config";
import { Mark } from "../components/Icons";
import { createTracker, drawOverlay, type Tracker } from "../lib/holistic";
import { createSegmenter, type SegState, type SegmentDone } from "../lib/segmenter";
import { SIGN_VOCAB } from "../lib/vocab";

type Option = RecognizeResponse["options"][number];
interface Entry { label: string; options?: Option[]; sel?: number }
type Cam = "starting" | "ready" | "denied" | "nocam" | "error";

const LOW = 0.4;
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
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<RecognizeMode>("sign");
  const [items, setItems] = useState<Entry[]>([]);
  const [edit, setEdit] = useState<{ text: string; at: number } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [sheet, setSheet] = useState<"signs" | "history" | null>(null);
  modeRef.current = mode;

  // ── Recognize one segment ──
  const onSegment = useCallback(async (s: SegmentDone) => {
    if (!s.count) { setHint("That was too short. Tap Sign and sign again."); return; }
    setBusy(true);
    setHint(null);
    const m = modeRef.current;
    const t0 = performance.now();
    try {
      const r = await client.recognize(m, s.frames);
      if (!alive.current) return;
      window.__sl = { ...window.__sl, last: r, frames: s.count, segMs: Math.round(s.ms), reason: s.reason, rtMs: Math.round(performance.now() - t0) };
      setBanner(null);
      if (m === "spell") {
        const word = (r.text ?? "").replace(/[^A-Za-z' -]/g, "").trim();
        if (!word) { setHint("No letters read. Spell a bit slower, facing the camera."); return; }
        setItems((xs) => [...xs, { label: `#${word.toUpperCase()}` }]);
        return;
      }
      const options = [...r.options].sort((a, b) => b.confidence - a.confidence);
      if (!options.length) { setHint("No sign recognized. Try again."); return; }
      setItems((xs) => [...xs, { label: options[0]!.label, options, sel: 0 }]);
      if (options[0]!.confidence < LOW) setHint("Not sure about this one. Tap the right word below, or sign it again.");
    } catch (e) {
      if (!alive.current) return;
      const err = e as Error;
      if (err instanceof SignApiError && err.status === 503) setBanner("The sign recognizer is offline (503). Start app/recognizer, then try again.");
      else if (err instanceof SignApiError && err.status === 404) setBanner(`This server has no sign recognizer yet (${apiLabel()}/api/recognize is 404). Try npm run dev:mock.`);
      else if (err instanceof SignApiError) setBanner(`The recognizer failed: ${err.message}`);
      else setBanner(`Can't reach the server at ${apiLabel()}. Is it running? (${err.message})`);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [client]);

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
  const clear = () => { setItems([]); setEdit(null); setHint(null); };
  const speak = () => {
    const text = sentence.trim();
    if (!text) return;
    if (embed) post({ type: "speak", text });
    else if ("speechSynthesis" in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      const voice = speechSynthesis.getVoices().find((v) => v.lang === "en-US");
      if (voice) u.voice = voice;
      speechSynthesis.speak(u);
    }
    setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 8));
  };

  const tap = () => {
    const s = segRef.current!;
    setHint(null);
    if (s.state === "idle") s.arm();
    else s.stop();
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
  const island = busy ? "Reading the sign" : seg === "recording" ? "Recording" : seg === "armed" ? (hands ? "Start signing" : "Show your hands") : !ready ? (cam === "starting" || track === "loading" ? "Starting camera" : "Camera off") : mode === "spell" ? "Spell mode" : "Ready to sign";
  const status = cam === "denied" || cam === "nocam" || cam === "error" ? "Camera unavailable" : cam === "starting" ? "Starting the camera…" : track === "loading" ? "Loading hand tracking…" : track === "error" ? "Hand tracking unavailable" : seg === "armed" ? (hands ? "Hands found. Sign now." : "Raise your hands into view") : seg === "recording" ? "Recording… hold still to finish" : busy ? "Reading…" : hands ? "Tracking your hands" : "Tap Sign, then sign one word";
  const btn = busy ? (mode === "spell" ? "Reading letters…" : "Reading…") : seg === "recording" ? "Done" : seg === "armed" ? "Cancel" : mode === "spell" ? "Spell" : "Sign";

  return (
    <div className={`screen signsp field${embed ? " embed" : ""}`}>
      <div className="g live" />
      <div className="bar live-bar">
        {embed ? <span /> : <button className="homebtn" aria-label="Home" onClick={onHome}><Mark /></button>}
        <span className={`island${seg === "recording" ? " rec" : ""}${!ready || (seg === "idle" && !busy) ? " idle" : ""}`} aria-live="polite"><i />{island}</span>
        <span className="fps" title={tracker.current ? `MediaPipe on ${tracker.current.delegate}` : ""}>{ready ? `${fps.toFixed(0)} fps` : "–"}</span>
      </div>

      {camMsg ? (
        <div className="banner" role="alert">{camMsg}{cam === "denied" || cam === "error" ? <button className="pill sm on retry" onClick={startCam}>Retry</button> : null}</div>
      ) : null}
      {banner ? <div className="banner" role="alert">{banner}</div> : null}

      <section className={`camcard sl-card${seg === "recording" ? " lit rec" : ""}`}>
        <div className="stage">
          <video ref={video} className="cam" muted playsInline autoPlay />
          <canvas ref={canvas} className="cam overlay" />
          <span className="sl-chip"><i />You<em>&nbsp;· {mode === "spell" ? "Spelling" : "Signing"}</em></span>
          <span className={`camstatus${hands ? " on" : ""}`}>{status}</span>
        </div>
        <div className="sl-cap sentence">
          <textarea aria-label="Sentence to speak" rows={2} spellCheck={false} placeholder="Your sentence shows up here" value={sentence}
            onChange={(e) => setEdit({ text: e.target.value, at: items.length })} />
          <div className="caprow">
            <button className="capbtn" onClick={undo} disabled={!items.length && !edit}>Undo</button>
            <button className="capbtn" onClick={clear} disabled={!items.length && !edit}>Clear</button>
            <button className="capbtn speak" onClick={speak} disabled={!sentence.trim()}>Speak</button>
          </div>
        </div>
      </section>

      <div className="cands" aria-label="Did you sign">
        {cands.map((o, i) => (
          <button key={o.label + i} className={`cand${last?.sel === i ? " on" : ""}`} onClick={() => choose(i)}>
            {o.text || labelText(o.label)}<em>{Math.round(o.confidence * 100)}%</em>
          </button>
        ))}
        {!cands.length ? <p className="candhint">{mode === "spell" ? "Fingerspell a name or word, letter by letter." : "Top guesses for each sign show up here."}</p> : null}
      </div>
      <p className="hint signhint" aria-live="polite">{hint ?? ""}</p>

      <div className="foot signfoot">
        <div className="signrow">
          <div className="seg" role="radiogroup" aria-label="Mode">
            <button role="radio" aria-checked={mode === "sign"} className={mode === "sign" ? "on" : ""} onClick={() => setMode("sign")}>Sign</button>
            <button role="radio" aria-checked={mode === "spell"} className={mode === "spell" ? "on" : ""} onClick={() => setMode("spell")}>Spell</button>
          </div>
          <button id="signbtn" className={`listenbtn signbtn${seg !== "idle" ? " armed" : ""}`} onClick={tap} disabled={!ready || busy}>
            {busy ? <i className="spin" aria-hidden="true" /> : <HandIcon />}{btn}
          </button>
        </div>
        <div className="footrow">
          <p className="credit">Knows {SIGN_VOCAB.length} everyday signs · <button className="textlink inline" onClick={() => setSheet("signs")}>See signs</button></p>
          <button className="textlink" onClick={() => setSheet("history")} disabled={!history.length}>Said{history.length ? ` (${history.length})` : ""}</button>
        </div>
      </div>

      {sheet ? (
        <div className="sheet-back" onClick={() => setSheet(null)}>
          <div className="sheet" role="dialog" aria-label={sheet === "signs" ? "Signs I know" : "Spoken"} onClick={(e) => e.stopPropagation()}>
            {sheet === "signs" ? (
              <>
                <h2>{SIGN_VOCAB.length} signs I know</h2>
                <p>Single ASL signs from the Kaggle GISLR set, one at a time. Anything else comes out as the closest of these, so check the guesses. Names: use Spell.</p>
                <div className="vocab">{[...SIGN_VOCAB].sort((a, b) => labelText(a).localeCompare(labelText(b))).map((l) => <span key={l}>{labelText(l)}</span>)}</div>
              </>
            ) : (
              <>
                <h2>Said</h2>
                <ul className="said">{history.map((h, i) => <li key={i}><span>{h}</span><button className="btn" onClick={() => { setEdit({ text: h, at: items.length }); setSheet(null); }}>Use</button></li>)}</ul>
              </>
            )}
            <div className="row"><span className="status" /><button className="btn primary" onClick={() => setSheet(null)}>Close</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const HandIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5V4a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a6.5 6.5 0 0 1-5.2-2.6L3.6 16a1.6 1.6 0 0 1 2.5-2l1.9 2" />
  </svg>
);
