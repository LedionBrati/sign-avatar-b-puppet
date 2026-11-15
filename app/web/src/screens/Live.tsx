// Live screen: listen (or read typed text) -> the signer card forms out of the wave -> clips play back to back while
// the captions light up word by word -> done (summary, Replay / Listen again).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copy, createSignClient, type SignResponse } from "@signlayer/core";
import { apiBase, apiLabel } from "../config";
import { Captions } from "../components/Captions";
import { Mark } from "../components/Icons";
import { Lane } from "../components/Lane";
import { SignerStage } from "../components/SignerStage";
import { TypeBox } from "../components/TypeBox";
import { Wave } from "../components/Wave";
import { prefetchClip, type GaplessPlayer } from "../lib/player";
import { sessionView, splitWords, type Phrase } from "../lib/session";
import { createListener, speechSupported } from "../lib/speech";

export type LiveStart = { kind: "mic" } | { kind: "typed"; text: string };

const WORD_MS = 210; // typed text is "heard" at about speaking pace under the wave
const MIN_LISTEN_MS = 1400;

export function Live({ start, onHome, onRestart }: { start: LiveStart; onHome(): void; onRestart(s: LiveStart): void }) {
  const client = useMemo(() => createSignClient(apiBase()), []);
  const player = useRef<GaplessPlayer | null>(null);
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [playing, setPlaying] = useState(-1);
  const [total, setTotal] = useState(0);
  const [micOn, setMicOn] = useState(false);
  const [interim, setInterim] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [arrive, setArrive] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [micRetry, setMicRetry] = useState(false);
  const [typing, setTyping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [heardShown, setHeardShown] = useState(0);
  const [bump, setBump] = useState(0);
  const listener = useRef<ReturnType<typeof createListener> | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const gate = useRef<{ p: Promise<void>; open(): void } | null>(null);
  const t0 = useRef(performance.now());
  const ids = useRef(0);
  const alive = useRef(true);

  if (!gate.current) {
    let open = () => {};
    const p = new Promise<void>((r) => (open = r));
    gate.current = { p, open };
  }

  const revealedRef = useRef(false);
  const reveal = useCallback(() => {
    if (revealedRef.current) return;
    revealedRef.current = true;
    setRevealed(true);
    setArrive(true);
    setBump((b) => b + 1);
    setTimeout(() => alive.current && gate.current!.open(), 550); // let the card form before signing
  }, []);

  const patch = (id: number, p: Partial<Phrase>) => setPhrases((ps) => ps.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const clearPlayback = (id: number, update: Partial<Phrase>) => {
    player.current?.clear();
    setPlaying(-1);
    setTotal(0);
    // Keep the transcript, but detach earlier clips so an old word cannot light up during recovery.
    setPhrases((ps) => ps.map((x) => x.id === id ? { ...x, ...update, offset: 0 }
      : x.res ? { ...x, res: { ...x.res, playlist: [], markers: [] }, offset: -2 } : x));
  };

  const submit = useCallback((text: string) => {
    const id = ++ids.current;
    setStopped(false);
    setPhrases((ps) => [...ps, { id, text, res: null, offset: -1 }]);
    const req = client.sign({ text });
    // Appends happen in phrase order, after the card has formed.
    chain.current = chain.current.then(async () => {
      let res: SignResponse;
      try {
        res = await req;
      } catch (e) {
        if (!alive.current) return;
        clearPlayback(id, { error: (e as Error).message });
        setBanner(`Can't reach the sign server at ${apiLabel()}. Is it running? (${(e as Error).message})`);
        reveal();
        return;
      }
      if (!alive.current) return;
      setBanner(null);
      res.playlist.forEach((x) => void prefetchClip(x.url)); // warm the clips while the card forms
      const wait = id === 1 && start.kind === "typed" ? Math.max(0, MIN_LISTEN_MS + splitWords(text).length * WORD_MS - (performance.now() - t0.current)) : 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (!alive.current) return;
      reveal();
      await gate.current!.p;
      if (!alive.current) return;
      const p = player.current;
      const offset = p ? p.length : 0;
      if (res.safety && res.safety.status !== "fully_supported") {
        clearPlayback(id, { res });
        return;
      }
      patch(id, { res, offset });
      if (p && res.playlist.length) {
        p.append(res.playlist.map((x) => ({ url: x.url, duration_s: x.duration_s })));
        setTotal(p.length);
      }
    });
  }, [client, reveal, start.kind]);

  // Mic
  const startMic = useCallback(() => {
    if (!speechSupported()) { setTyping(true); return; }
    setBanner(null);
    setMicRetry(false);
    const l = createListener({
      onInterim: (t) => alive.current && setInterim(t),
      onFinal: (t) => { if (alive.current) { setInterim(""); submit(t); } },
      onError: (kind) => {
        if (!alive.current) return;
        if (kind === "other") return;
        setMicOn(false);
        setTyping(true);
        setMicRetry(true);
        setBanner(kind === "denied" ? "Microphone access is blocked. Allow it from the icon in the address bar (or site settings) and tap Retry, or type below."
          : kind === "no-mic" ? "No microphone found. Plug one in, or type below."
          : "Speech recognition needs an internet connection in this browser. You can type below.");
      },
    });
    listener.current = l;
    l.start();
    setMicOn(true);
  }, [submit]);

  const stopMic = useCallback(() => { listener.current?.stop(); setMicOn(false); setInterim(""); }, []);

  useEffect(() => {
    alive.current = true;
    t0.current = performance.now();
    if (start.kind === "mic") startMic();
    else submit(start.text);
    return () => { alive.current = false; listener.current?.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Typed text builds up under the wave at speaking pace.
  const firstWords = useMemo(() => (start.kind === "typed" ? splitWords(start.text) : []), [start]);
  useEffect(() => {
    if (start.kind !== "typed" || revealed) return;
    if (heardShown >= firstWords.length) return;
    const t = setTimeout(() => setHeardShown((n) => n + 1), heardShown === 0 ? 450 : WORD_MS);
    return () => clearTimeout(t);
  }, [heardShown, firstWords, revealed, start.kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onHome(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onHome]);

  const onPlayer = useCallback((p: GaplessPlayer | null) => {
    player.current = p;
    if (p) p.onIndex = (i) => alive.current && setPlaying(i);
  }, []);

  const view = useMemo(() => sessionView(phrases, playing, interim), [phrases, playing, interim]);
  const safety = phrases.at(-1)?.res?.safety;
  const latestUnsupported = phrases.at(-1)?.res?.unsupported ?? [];
  const latestFingerspell = phrases.at(-1)?.res?.fingerspell ?? [];
  const latestError = phrases.at(-1)?.error;
  const blocked = safety && safety.status !== "fully_supported";
  const settled = phrases.length > 0 && phrases.every((p) => p.offset !== -1);
  const drained = total === 0 || playing >= total;
  const done = !micOn && settled && (drained || stopped) && revealed;
  const pending = phrases.some((p) => p.offset === -1);
  const secs = phrases.reduce((s, p) => s + (p.res?.playlist.reduce((a, x) => a + x.duration_s, 0) ?? 0), 0);

  const island = !revealed ? (micOn ? "Listening" : start.kind === "typed" ? "Reading" : "Mic off")
    : latestError ? "Connection lost"
    : blocked ? (safety.status === "needs_confirmation" ? "Meaning unclear" : "Caption only")
    : done ? "1 speaker · Done" : "1 speaker";

  function stop() {
    if (!phrases.length) { stopMic(); onHome(); return; }
    if (micOn) { stopMic(); return; }
    player.current?.stop();
    setStopped(true);
  }

  // Under the big wave: what has been heard so far.
  const heardWords = start.kind === "typed" ? firstWords.slice(0, heardShown) : phrases.flatMap((p) => splitWords(p.text));
  const interimWords = splitWords(interim);

  return (
    <div className={`screen live field${revealed ? "" : " listening"}`}>
      <div className="g live" />
      <div className="bar live-bar">
        <button className="homebtn" aria-label="Home" onClick={onHome}><Mark /></button>
        <span key={bump} className={`island${bump ? " bump" : ""}${done || (!micOn && !revealed && start.kind === "mic") ? " idle" : ""}`} aria-live="polite"><i />{island}</span>
        <button className={`pill sm stopbtn${done ? " hide" : ""}`} onClick={stop}>Stop</button>
      </div>

      {banner ? (
        <div className="banner" role="alert">
          {banner}
          {micRetry ? <button className="pill sm on retry" onClick={startMic}>Retry</button> : null}
        </div>
      ) : null}

      <div className="lanes">
        <Lane index={0} label="Speaker 1" mode={revealed ? (done ? "rest" : "lit") : "unseen"} arrive={arrive} speaking={view.now >= 0}
          stage={<SignerStage onReady={onPlayer} on={revealed} label={blocked || latestError ? "Signing paused; caption shown" : "Speaker 1, signed"}
            safety={safety} error={latestError ? { caption: phrases.at(-1)?.text ?? "", message: latestError } : undefined} />}
          caption={<Captions words={view.words} now={view.now} lines={2} />} />
        <div className={`listen${revealed ? " off" : ""}`} aria-live="polite">
          <Wave level={0.95} talking={!revealed && (micOn || start.kind === "typed")} />
          <span className="lbl">{micOn || start.kind === "typed" ? "Listening…" : "Not listening"}</span>
          <p className="heardtxt">
            {heardWords.map((w, i) => <span key={i}>{w} </span>)}
            {interimWords.map((w, i) => <span key={`i${i}`} className="interim">{w} </span>)}
          </p>
        </div>
      </div>

      <div className="foot">
        {done ? (
          <>
            {latestError ? <p className="sumline"><span><b>Signing unavailable</b></span><span>Server connection failed</span></p>
              : blocked ? <p className="sumline"><span><b>{safety.status === "needs_confirmation" ? "Meaning needs confirmation" : "Caption only"}</b></span><span>No signing for this message</span></p>
              : <p className="sumline"><span><b>Signed</b></span><span>1 voice</span><span>{total} sign{total === 1 ? "" : "s"}</span><span>{Math.round(secs)} s</span></p>}
            <Hints u={latestUnsupported} f={latestFingerspell} />
            <div className="acts">
              {!blocked && !latestError ? <button className="pill sm" onClick={() => player.current?.replay()} disabled={!total}>Replay</button> : null}
              <button className="pill sm on" onClick={() => onRestart(speechSupported() ? { kind: "mic" } : { kind: "typed", text: "" })}>
                {speechSupported() ? "Listen again" : "Type again"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="nowline">
              {view.nowGloss ? (
                <>Signing <b>{view.nowGloss}</b>{view.nowWord ? <> <span className="for">for “{view.nowWord}”</span></> : null}</>
              ) : micOn ? "Listening…" : pending ? "Translating…" : ""}
            </p>
            {revealed ? <Hints u={latestUnsupported} f={latestFingerspell} /> : null}
          </>
        )}
        {typing ? <TypeBox onSubmit={submit} autoFocus placeholder="Type to sign" /> : null}
        <div className="footrow">
          <p className="credit">{copy.credit}</p>
          {!typing ? <button className="textlink" onClick={() => setTyping(true)}>Type</button> : null}
        </div>
      </div>
    </div>
  );
}

function Hints({ u, f }: { u: string[]; f: string[] }) {
  if (!u.length && !f.length) return null;
  return (
    <p className="hint">
      {u.length ? <>Can't sign yet: <b>{u.join(", ")}</b>. </> : null}
      {f.length ? <>Fingerspelling not available yet: <b>{f.map((x) => x[0] + x.slice(1).toLowerCase()).join(", ")}</b>.</> : null}
    </p>
  );
}
