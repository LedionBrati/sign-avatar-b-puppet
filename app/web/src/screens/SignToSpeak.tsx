// Sign -> speak, continuous: the front camera, MediaPipe Holistic landmarks, always reading while the camera is on
// (no tap per sign). Sign mode (STREAM): lib/stream.ts reads sliding ~1 s windows while the hands move and accepts a
// sign once it wins 2 windows in a row (junk motion / toddler words filtered); STREAM=false (and Spell mode) use the
// rest-based segmenter (lib/segmenter.ts on the shared cutter app/core/src/segment.ts): every segment goes to
// POST /api/recognize. Closed vocabulary (prefs.closedVocab, the default): the demo signs only, read by the profile's
// personal model ("Train my signs", #/train; profile "demo" = the generic one) + the GISLR prior; a segment can hold
// several signs (signs[]); "no sign" pieces are dropped, unsure ones kept with the hint and the chips. Top-1 is appended (top-3 chips to correct it), and
// the words show live in the sentence box. With the server's OpenAI layer (health.compose), every new sign asks
// POST /api/compose in the background (top-5 guesses + the session's conversation from lib/chat.ts; stale calls are
// aborted). Nothing is spoken while the signer is still signing: once the hands have rested ~900 ms (or left the
// frame) and no window is still being read, the model's sentence for exactly these signs is spoken once, waiting up
// to 1.2 s for it, else the local composeSentence. At 8 signs it is spoken anyway. Reading goes on while it speaks.
// Voice: one POST /api/speak (natural TTS) per phrase on one reused <audio>, else speechSynthesis.
// Pause/Resume stops reading; Undo/Clear/edit + Speak stay available.
// "#/sign?embed=1" is the same screen for the phone app's WebView: results also go to window.ReactNativeWebView.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_SIGNS, SignApiError, composeSentence, createSignClient, knownPhrase, labelText, type RecognizeMode, type RecognizeResponse } from "@signlayer/core";
import { apiBase, apiLabel } from "../config";
import { ClockIcon, CloseIcon, GridIcon, HandIcon, PauseIcon, SpeakerIcon, UndoIcon } from "../components/Icons";
import { Segmented } from "../components/Segmented";
import { createTracker, drawOverlay, type Tracker } from "../lib/holistic";
import { SPELL_SEG, createSegmenter, type SegState, type SegmentDone } from "../lib/segmenter";
import { createStream, dejunk, type RestInfo, type StreamSign } from "../lib/stream";
import { readHeard } from "../lib/heard";
import { addTurn, recentHistory } from "../lib/chat";
import { SIGN_VOCAB } from "../lib/vocab";
import { navigate } from "../lib/route";
import { setPrefs, usePrefs } from "../lib/prefs";
import { playVoice, stopVoice, unlockVoice } from "../lib/voice";

type Option = RecognizeResponse["options"][number];
/** fixed: the signer picked this guess from the chips, so the model gets it as certain. */
interface Entry { label: string; options?: Option[]; sel?: number; fixed?: boolean }
type Cam = "starting" | "ready" | "denied" | "nocam" | "error";

const LOW = 0.35; // below this the top-3 chips get a "not sure" hint
/** false = no sentence model call: every recognized sign is spoken as its word right away. true = one sentence per phrase. */
const SENTENCES = true;
/** false = sentences are built locally (composeSentence rules), no OpenAI generation. true = /api/compose. */
const MODEL = true;
const MIN_CONF = 0.25; // a sign is only taken when the recognizer is at least this sure
const WORD_CLEAR_MS = 6000; // word mode: the sentence box clears this long after the last sign
/** true = sliding-window recognition (lib/stream.ts) in Sign mode; false = the rest-based segmenter (lib/segmenter.ts). */
const STREAM = false;
const REST_MS = 900; // hands rested this long (nothing still being read) -> speak
const WAIT_MS = 1200; // at rest, wait this long for the model's sentence, then speak the local one
const HISTORY_TURNS = 10; // conversation turns sent with every compose call
const CAP = 8; // spoken at this many signs even without a rest
const VOICE_MS = 12000; // natural voice not back by then -> the device voice
const END_LAG_MS = 300; // the segmenter needs ~this much stillness before it ends a segment
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
/** potty is read by its bathroom meaning (the server's sentence model does the same). */
const localLabel = (l: string) => (l.toLowerCase() === "potty" ? "bathroom" : l);
const wordOf = (l: string) => (l.startsWith("#") ? cap(l.slice(1).toLowerCase()) : labelText(localLabel(l)));
const localSentence = (xs: Entry[]) => composeSentence(xs.map((x) => localLabel(x.label)));
const fixedSentence = (xs: Entry[]) => knownPhrase(xs.map((x) => localLabel(x.label)));
/** Words of the demo sentences: preferred (not forced) when the recognizer is torn between them and other words. */
const DEMO_WORDS = new Set("hello how are you your today day good evening night morning thank you thankyou all very much judge luck lucky can i me my have some coffee water please want build company nice meet name where bathroom yes no fine happy see later tomorrow help sorry".split(" "));
const DEMO_BOOST = 1.5;
const preferDemo = <T extends { label: string; text?: string; confidence: number }>(xs: T[]): T[] =>
  xs.map((x) => (DEMO_WORDS.has((x.text || labelText(x.label)).toLowerCase()) || DEMO_WORDS.has(x.label.toLowerCase()) ? { ...x, confidence: Math.min(1, x.confidence * DEMO_BOOST) } : x))
    .sort((a, b) => b.confidence - a.confidence);
const keyOf = (epoch: number, xs: Entry[]) => `${epoch}|${xs.map((x) => x.label).join(" ")}`;

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
  const prefs = usePrefs();
  const closed = prefs.closedVocab !== false;
  const vocab = useMemo(() => (prefs.signVocab?.length ? prefs.signVocab : [...DEMO_SIGNS]), [prefs.signVocab]);
  const closedRef = useRef({ on: closed, profile: prefs.signProfile || "demo", vocab });
  closedRef.current = { on: closed, profile: prefs.signProfile || "demo", vocab };
  const fpsRef = useRef(30);

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
  /** When the hands stopped (last motion, or last seen when they left the frame): the rest timer counts from here. */
  const [restFrom, setRestFrom] = useState<RestInfo>({ since: 0, gone: false });
  const [mode, setMode] = useState<RecognizeMode>("sign");
  const [items, setItems] = useState<Entry[]>([]);
  const [edit, setEdit] = useState<{ text: string; at: number } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [sheet, setSheet] = useState<"signs" | "history" | null>(null);
  /** Model sentence for the exact signs it was asked about (key = epoch + labels); null until it answers. */
  const [composed, setComposed] = useState<{ key: string; sentence: string } | null>(null);
  const composedRef = useRef<{ key: string; sentence: string } | null>(null);
  const [composing, setComposing] = useState(false);
  const aiOn = useRef(MODEL); // off when health says compose is off, or the server answers 404 / 503
  const [lastSaid, setLastSaid] = useState(""); // the last spoken sentence stays visible in the empty box
  const pendingVoice = useRef<{ blob: Blob; done: () => void } | null>(null);
  useEffect(() => {
    const onTap = () => {
      unlockVoice();
      const p = pendingVoice.current;
      if (p) { pendingVoice.current = null; setHint(null); void playVoice(p.blob, p.done).catch(() => {}); }
    };
    addEventListener("pointerdown", onTap);
    return () => removeEventListener("pointerdown", onTap);
  }, []);
  const voiceOn = useRef(true); // natural voice (POST /api/speak); off when health says speak is off, or 404 / 503
  /** Set while the hands are at rest and we wait for the model's sentence for exactly these signs (keyOf). */
  const restKey = useRef<string | null>(null);
  /** The last 2 sentences this screen spoke, oldest first (context for the model). */
  const said = useRef<string[]>([]);
  modeRef.current = mode;

  // ── Recognize segments: parallel requests, results appended in segment order; a Clear/Pause/spoken sentence
  // makes the still-pending ones stale (epoch) so they never land in the next sentence. ──
  const order = useRef({ seq: 0, next: 1, epoch: 0, done: new Map<number, { epoch: number; entries: Entry[] }>() });
  const flush = useCallback(() => {
    const o = order.current;
    const add: Entry[] = [];
    while (o.done.has(o.next)) {
      const r = o.done.get(o.next)!;
      o.done.delete(o.next++);
      if (r.epoch === o.epoch) add.push(...r.entries);
    }
    if (add.length) setItems((xs) => [...xs, ...add]);
  }, []);

  const showError = useCallback((e: unknown) => {
    if (!alive.current) return;
    const err = e as Error;
    if (err instanceof SignApiError && err.status === 503) setBanner("The sign recognizer is offline (503). Start app/recognizer, then try again.");
    else if (err instanceof SignApiError && err.status === 404) setBanner(`This server has no sign recognizer yet (${apiLabel()}/api/recognize is 404). Try npm run dev:mock.`);
    else if (err instanceof SignApiError) setBanner(`The recognizer failed: ${err.message}`);
    else setBanner(`Can't reach the server at ${apiLabel()}. Is it running? (${err.message})`);
  }, []);

  const onSegment = useCallback(async (s: SegmentDone) => {
    setRestFrom({ since: performance.now() - END_LAG_MS, gone: s.reason === "gone" });
    if (!s.count) return; // a twitch, or the hands going back to rest: keep reading
    const o = order.current;
    const id = ++o.seq, epoch = o.epoch;
    const entries: Entry[] = [];
    setPending((n) => n + 1);
    const m = modeRef.current;
    const t0 = performance.now();
    try {
      const cv = closedRef.current;
      const r = await client.recognize(m, s.frames, m === "sign" && cv.on ? { profile: cv.profile, vocab: cv.vocab, fps: fpsRef.current } : {});
      if (!alive.current) return;
      window.__sl = { ...window.__sl, last: r, frames: s.count, segMs: Math.round(s.ms), reason: s.reason, rtMs: Math.round(performance.now() - t0), recognized: ((window.__sl?.recognized as number) ?? 0) + 1 };
      setBanner(null);
      if (m === "spell") {
        const word = (r.text ?? "").replace(/[^A-Za-z' -]/g, "").trim();
        if (word) entries.push({ label: `#${word.toUpperCase()}` });
      } else if (r.signs) {
        // closed vocabulary: every sign the server found in this segment; "unsure" ones are dropped
        let unsure = false;
        for (const g of r.signs) if (!g.reject && g.options.length) { entries.push({ label: g.options[0]!.label, options: g.options, sel: 0 }); unsure = Boolean(g.unsure); }
        const last = entries[entries.length - 1];
        if (epoch === o.epoch) setHint(!last ? null : unsure || last.options![0]!.confidence < LOW ? "Not sure about that one. Tap the right word below." : null);
      } else {
        const options = r.reject ? [] : preferDemo(dejunk(r.options)).filter((x) => x.confidence >= MIN_CONF); // no sign / junk / too unsure -> nothing
        if (options.length) {
          entries.push({ label: options[0]!.label, options, sel: 0 });
          if (epoch === o.epoch) setHint(options[0]!.confidence < LOW ? "Not sure about that one. Tap the right word below." : null);
        }
      }
    } catch (e) {
      showError(e);
    } finally {
      if (alive.current) {
        o.done.set(id, { epoch, entries });
        flush();
        setPending((n) => n - 1);
      }
    }
  }, [client, flush, showError]);

  const onSegmentRef = useRef(onSegment);
  onSegmentRef.current = onSegment;
  const segRef = useRef<ReturnType<typeof createSegmenter> | null>(null);
  if (!segRef.current) segRef.current = createSegmenter((s) => void onSegmentRef.current(s), (s) => alive.current && setSeg(s));

  // ── Sliding-window reading (Sign mode, STREAM): one window in flight at most; accepted signs are appended. ──
  const streamRef = useRef<ReturnType<typeof createStream> | null>(null);
  const recognizeWindow = useCallback(async (frames: Float32Array) => {
    setPending((n) => n + 1);
    try {
      const r = await client.recognize("sign", frames);
      if (alive.current) setBanner(null);
      return r;
    } catch (e) {
      showError(e);
      throw e;
    } finally {
      if (alive.current) setPending((n) => n - 1);
    }
  }, [client, showError]);
  const onStreamSign = useCallback((s: StreamSign) => {
    if (!alive.current || !s.options.length) return;
    window.__sl = { ...window.__sl, last: s, stream: streamRef.current?.stats, recognized: ((window.__sl?.recognized as number) ?? 0) + 1 };
    setItems((xs) => [...xs, { label: s.label, options: s.options, sel: 0 }]);
    setHint(s.options[0]!.confidence < LOW ? "Not sure about that one. Tap the right word below." : null);
  }, []);
  const streamCbs = useRef({ recognizeWindow, onStreamSign });
  streamCbs.current = { recognizeWindow, onStreamSign };
  if (!streamRef.current) {
    streamRef.current = createStream(
      (f) => streamCbs.current.recognizeWindow(f),
      (s) => streamCbs.current.onStreamSign(s),
      (s, rest) => { if (!alive.current) return; setSeg(s); if (rest) setRestFrom(rest); },
    );
  }

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
    client.health().then((h) => { aiOn.current = MODEL && h.compose === "ready"; voiceOn.current = h.speak === "ready"; if (alive.current && h.recognizer === "down") setBanner("The sign recognizer is offline. Start app/recognizer; signing won't work until then."); }).catch(() => {});
    return () => {
      alive.current = false;
      const s = video.current?.srcObject as MediaStream | null;
      s?.getTracks().forEach((t) => t.stop());
      tracker.current?.close();
      tracker.current = null;
      stopVoice();
    };
  }, [client, startCam]);

  // The camera screen speaks without a gesture: unlock the audio element on the first tap / click / key anywhere.
  useEffect(() => {
    if (embed) return;
    const on = () => unlockVoice();
    addEventListener("pointerdown", on, { capture: true });
    addEventListener("keydown", on, { capture: true });
    return () => { removeEventListener("pointerdown", on, { capture: true }); removeEventListener("keydown", on, { capture: true }); };
  }, [embed]);

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
        if (STREAM && modeRef.current === "sign") streamRef.current!.push(f, performance.now());
        else segRef.current!.push(f, performance.now());
        const h = Boolean(f.leftHand?.length || f.rightHand?.length);
        if (h !== sawHands) { sawHands = h; setHands(h); }
        n++;
        if (now - win >= 1000) { const r = (n * 1000) / (now - win); setFps(r); fpsRef.current = r; window.__sl = { ...window.__sl, fps: +r.toFixed(1), detectMs: Math.round(dms / n) }; n = 0; dms = 0; win = now; }
      }
      next();
    };
    next();
    return () => { stop = true; if (rvfc) v.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle); };
  }, [cam, track]);

  // Fingerspelling holds each letter: only a long pause ends a word there.
  useEffect(() => { segRef.current!.configure(mode === "spell" ? SPELL_SEG : {}); }, [mode]);

  // ── Camera on => always reading (until Pause) ──
  useEffect(() => {
    const useStream = STREAM && mode === "sign";
    const sg = useStream ? streamRef.current! : segRef.current!;
    (useStream ? segRef.current! : streamRef.current!).cancel(); // the other reader stays off
    if (cam === "ready" && track === "ready" && !paused) { if (sg.state === "idle") sg.arm(); }
    else sg.cancel();
  }, [cam, track, paused, mode]);

  // ── Sentence ──
  const sentence = useMemo(() => {
    if (!edit) return composed?.sentence && composed.key === keyOf(order.current.epoch, items) ? composed.sentence : localSentence(items);
    const rest = items.slice(edit.at).map((x) => wordOf(x.label));
    if (!rest.length) return edit.text;
    const base = edit.text.trim().replace(/[.?!]+$/, "");
    return base ? `${base} ${rest.join(" ")}.` : localSentence(items.slice(edit.at));
  }, [items, edit, composed]);

  useEffect(() => { if (embed) post({ type: "sentence", text: sentence }); }, [sentence, embed]);

  const choose = (i: number) => {
    setItems((xs) => {
      const last = xs[xs.length - 1];
      if (!last?.options?.[i]) return xs;
      return [...xs.slice(0, -1), { ...last, label: last.options[i]!.label, sel: i, fixed: true }];
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
    setLastSaid(text);
    const done = () => { if (alive.current) setSpeaking((x) => (x === text ? null : x)); };
    const robot = () => {
      if (!("speechSynthesis" in window)) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      const voice = speechSynthesis.getVoices().find((v) => v.lang === "en-US");
      if (voice) u.voice = voice;
      u.onend = u.onerror = done;
      speechSynthesis.speak(u);
    };
    if (embed) post({ type: "speak", text });
    else if (voiceOn.current) {
      client.speak(text, { signal: AbortSignal.timeout(VOICE_MS) }) // exactly one /api/speak per spoken phrase
        .then((blob) => {
          if (!alive.current) return;
          return playVoice(blob, done).catch(() => {
            // Browser blocked sound (no tap yet): keep the natural voice and play it on the first tap.
            // Never fall back to the robot voice: hold the natural voice and play it on the next tap.
            pendingVoice.current = { blob, done };
            setHint("Tap anywhere to turn on the voice.");
          });
        })
        .catch((e) => {
          if (e instanceof SignApiError && (e.status === 404 || e.status === 503)) voiceOn.current = false;
          if (alive.current && !voiceOn.current) robot(); // only when the server has no natural voice at all
        });
    } else robot();
    setSpeaking(text);
    clearTimeout(speakTimer.current);
    speakTimer.current = window.setTimeout(done, 2500 + text.length * 70);
    said.current = [...said.current, text].slice(-2);
    addTurn("me", text); // the session's conversation (Live adds what the hearing person said)
    setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 8));
  }, [embed, client]);
  /** Speak the sentence and start a fresh one. The same text twice in a row is not spoken again. */
  const speak = () => {
    const text = sentence.trim();
    if (!text) return;
    if (text !== lastSpoken.current) { lastSpoken.current = text; speakText(text); }
    fresh();
  };
  const speakRef = useRef(speak);
  speakRef.current = speak;

  /** Speak a finished sentence and start fresh (same text twice in a row is not repeated). */
  const autoSpeak = useCallback((text: string) => {
    restKey.current = null;
    if (text && text !== lastSpoken.current) { lastSpoken.current = text; speakText(text); }
    order.current.epoch++; setItems([]); setEdit(null); setHint(null);
  }, [speakText]);

  // With the model: every new sign -> ask for the sentence in the background (aborting the stale call). It is only
  // spoken at rest (below); if the hands are already resting and waiting for exactly this answer, it is spoken now.
  const [aiFailed, setAiFailed] = useState(false);
  // Word mode (SENTENCES off): say each newly recognized sign as its word, keep the words building up in the
  // sentence box, and start fresh only after WORD_CLEAR_MS without a new sign (or on Clear).
  const saidCount = useRef(0);
  useEffect(() => {
    if (SENTENCES) return;
    if (items.length < saidCount.current) saidCount.current = items.length; // Undo / Clear
    if (paused || editing || edit || items.length <= saidCount.current) return;
    const word = wordOf(items[items.length - 1]!.label);
    saidCount.current = items.length;
    restKey.current = null;
    speakText(word);
  }, [items, paused, editing, edit, speakText]);
  useEffect(() => {
    if (SENTENCES || paused || editing || !items.length) return;
    const t = window.setTimeout(() => { saidCount.current = 0; order.current.epoch++; setItems([]); setEdit(null); setHint(null); }, WORD_CLEAR_MS);
    return () => clearTimeout(t);
  }, [items, paused, editing]);
  useEffect(() => {
    if (!SENTENCES || !aiOn.current || aiFailed || paused || editing || edit || !items.length || fixedSentence(items)) return;
    const key = keyOf(order.current.epoch, items);
    const ctrl = new AbortController();
    setComposing(true);
    const heard = readHeard();
    const history = recentHistory(HISTORY_TURNS);
    const context = said.current.length || heard || history.length
      ? { ...(said.current.length ? { said: said.current } : {}), ...(heard ? { heard } : {}), ...(history.length ? { history } : {}) }
      : undefined;
    const signs = items.map((x) => ({
      text: wordOf(x.label),
      ...(x.fixed ? { options: [{ text: wordOf(x.label), confidence: 1 }] }
        : x.options ? { options: x.options.slice(0, 5).map((o) => ({ text: o.text || labelText(o.label), confidence: o.confidence })) } : {}),
    }));
    client.compose({ signs, ...(context ? { context } : {}) }, ctrl.signal)
      .then((r) => {
        if (!alive.current || ctrl.signal.aborted || keyOf(order.current.epoch, items) !== key) return;
        window.__sl = { ...window.__sl, compose: r };
        const sentence = r.sentence.trim();
        composedRef.current = { key, sentence };
        setComposed({ key, sentence });
        if (restKey.current === key) {
          if (sentence) autoSpeak(sentence);
          else restKey.current = null; // every sign dropped as noise: keep them on screen, nothing to say
        }
      })
      .catch((e) => {
        if (!alive.current || ctrl.signal.aborted) return;
        if (e instanceof SignApiError && (e.status === 404 || e.status === 503)) aiOn.current = false;
        setAiFailed(true); // this sentence falls back to the local rules; the next one tries the model again
      })
      .finally(() => { if (!ctrl.signal.aborted && alive.current) setComposing(false); });
    return () => { ctrl.abort(); setComposing(false); };
  }, [items, paused, editing, edit, client, autoSpeak, aiFailed]);
  useEffect(() => { if (!items.length) { setAiFailed(false); setComposed(null); composedRef.current = null; } }, [items]);

  // Speak on rest: hands still ~REST_MS and nothing still being read (or CAP signs) -> the model's sentence for exactly
  // these signs; if it isn't back yet, wait up to WAIT_MS for it, then the local composeSentence. After an edit, the
  // edited sentence (plus any signs since) is spoken at rest once something new was signed.
  useEffect(() => {
    if (!SENTENCES || paused || editing || !items.length) return;
    if (edit && items.length <= edit.at) return; // only the typed edit: the signer presses Speak
    const full = items.length >= CAP;
    if (!full && (seg === "recording" || pending > 0)) return;
    const key = keyOf(order.current.epoch, items);
    const local = localSentence(items);
    let waitT = 0;
    const restT = window.setTimeout(() => {
      if (edit) { speakRef.current(); return; }
      const fixed = fixedSentence(items); // known phrases are always worded the same, no model call
      if (fixed) { autoSpeak(fixed); return; }
      if (!aiOn.current || aiFailed) { autoSpeak(local); return; }
      const c = composedRef.current;
      if (c?.key === key) { if (c.sentence) autoSpeak(c.sentence); return; }
      restKey.current = key; // the compose answer speaks as soon as it lands...
      waitT = window.setTimeout(() => { if (restKey.current === key) autoSpeak(local); }, WAIT_MS); // ...or not
    }, full || restFrom.gone ? 0 : Math.max(0, REST_MS - (performance.now() - restFrom.since))); // hands left the frame: at once
    return () => { clearTimeout(restT); clearTimeout(waitT); if (restKey.current === key) restKey.current = null; };
  }, [items, seg, pending, paused, editing, edit, restFrom, aiFailed, autoSpeak]);

  const tap = () => {
    unlockVoice();
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
  const busy = pending > 0 || composing;
  const status = cam === "denied" || cam === "nocam" || cam === "error" ? "Camera unavailable" : cam === "starting" ? "Starting the camera…" : track === "loading" ? "Loading hand tracking…" : track === "error" ? "Hand tracking unavailable" : paused ? "Paused. Tap Resume to keep reading." : seg === "recording" ? "Signing… rest your hands to speak" : busy ? "Reading…" : hands ? "Hands found. Sign a word." : "Raise your hands and sign";
  const btn = paused ? "Resume" : "Pause";
  return (
    <div className={`screen signsp${embed ? " embed" : ""}`}>
      <header className="topbar">
        {embed ? <span /> : <button className="circbtn" aria-label="Close" title="Close" onClick={onHome}><CloseIcon /></button>}
        {embed ? <span /> : <button className="textbtn trainbtn" onClick={() => navigate("/train")} title="Record your own signs so they are read better">Train my signs</button>}
        <button className="circbtn" aria-label="Signs I know" title={`${closed ? vocab.length : SIGN_VOCAB.length} signs I know`} onClick={() => setSheet("signs")}><GridIcon /></button>
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
          {!cands.length ? <p className="candhint">{mode === "spell" ? "Fingerspell a name, letter by letter." : closed ? `Just sign · ${vocab.length} demo signs${prefs.signProfile && prefs.signProfile !== "demo" ? ` · ${prefs.signProfile}` : ""}` : `Just sign · ${SIGN_VOCAB.length} signs`}</p> : null}
        </div>
        <div className="sentence">
          <textarea aria-label="Sentence to speak" rows={2} spellCheck={false} placeholder={lastSaid || "Your sentence"} value={sentence}
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
              <h2>{sheet === "signs" ? `${closed ? vocab.length : SIGN_VOCAB.length} signs` : "Said"}</h2>
              <button className="textbtn" onClick={() => setSheet(null)} autoFocus>Done</button>
            </header>
            {sheet === "signs" ? (
              <>
                {closed ? (
                  <p className="lede">Demo signs only{prefs.signProfile && prefs.signProfile !== "demo" ? `, read with ${prefs.signProfile}'s own reps` : ""}. Anything else is left out as "not sure". Record your own reps with Train my signs. For names, use Spell.</p>
                ) : (
                  <p className="lede">Single ASL signs from the Kaggle GISLR set, one at a time. Anything else comes out as the closest of these, so check the guesses. For names, use Spell.</p>
                )}
                <div className="group vocab">{[...(closed ? vocab : SIGN_VOCAB)].sort((a, b) => labelText(a).localeCompare(labelText(b))).map((l) => <span key={l}>{labelText(l)}</span>)}</div>
                <div className="caprow"><button className="capbtn" onClick={() => setPrefs({ closedVocab: !closed })}>{closed ? "Use all 250+ signs" : "Demo signs only"}</button></div>
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
