// Live screen: listen (or read typed text) under an audio-reactive glow -> the signer card springs up -> clips play
// back to back while the captions light up word by word -> done (Replay / Listen again). The island narrates.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSignClient, generatingLabel, type SignResponse } from "@signlayer/core";
import { apiBase, apiLabel } from "../config";
import { Captions } from "../components/Captions";
import { CaptionsIcon, CloseIcon, KeyboardIcon, MicIcon, ReplayIcon, StopIcon } from "../components/Icons";
import { Island, type IslandTone } from "../components/Island";
import { SignerStage } from "../components/SignerStage";
import { TypeBox } from "../components/TypeBox";
import { Wave } from "../components/Wave";
import { prefetchClip, type GaplessPlayer } from "../lib/player";
import { setPrefs, usePrefs } from "../lib/prefs";
import { sessionView, splitWords, type Phrase } from "../lib/session";
import { createListener, speechSupported } from "../lib/speech";
import { useLevel, type LevelSource } from "../lib/useLevel";

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
  const [banner, setBanner] = useState<string | null>(null);
  const [micRetry, setMicRetry] = useState(false);
  const [typing, setTyping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [heardShown, setHeardShown] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const [waveGone, setWaveGone] = useState(false); // unmount the wave once the card is up, so it stops drawing
  const prefs = usePrefs();
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
    setTimeout(() => alive.current && gate.current!.open(), 520); // let the card spring up before signing
    setTimeout(() => alive.current && setWaveGone(true), 900);
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
        if (kind === "paused") {
          // The browser stopped restarting the mic on its own (iOS Safari). One tap restarts it.
          setMicOn(false);
          setMicRetry(true);
          setBanner("Tap Retry to keep listening (this browser pauses the mic between phrases).");
          return;
        }
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
  const generating = generatingLabel(phrases.at(-1)?.res);   // "Generating SICK… ~2 min": the server is making the missing clip
  const blocked = safety && safety.status !== "fully_supported";
  const settled = phrases.length > 0 && phrases.every((p) => p.offset !== -1);
  const drained = total === 0 || playing >= total;
  const done = !micOn && settled && (drained || stopped) && revealed;
  const pending = phrases.some((p) => p.offset === -1);
  const secs = phrases.reduce((s, p) => s + (p.res?.playlist.reduce((a, x) => a + x.duration_s, 0) ?? 0), 0);

  let tone: IslandTone, label: string, detail: string | undefined;
  if (!revealed) [tone, label] = micOn ? ["live", "Listening"] : start.kind === "typed" ? ["live", "Reading"] : ["idle", "Mic off"];
  else if (latestError) [tone, label] = ["warn", "Offline"];
  else if (blocked) [tone, label] = ["warn", safety.status === "needs_confirmation" ? "Meaning unclear" : "Caption only"];
  else if (done) [tone, label, detail] = ["done", "Done", total ? `${total} sign${total === 1 ? "" : "s"}` : undefined];
  else if (view.nowGloss) [tone, label, detail] = ["sign", "Signing", view.nowGloss];
  else if (pending) [tone, label] = ["busy", "Translating"];
  else if (micOn) [tone, label] = ["live", "Listening"];
  else [tone, label] = ["idle", "Ready"];

  const source: LevelSource = !revealed ? (micOn ? "mic" : start.kind === "typed" ? "voice" : "rest") : micOn && !view.nowGloss ? "mic" : done ? "rest" : "calm";
  const level = useLevel(root, source);
  const getLevel = useCallback(() => level.current, [level]);

  function stop() {
    if (!phrases.length) { stopMic(); onHome(); return; }
    if (micOn) { stopMic(); return; }
    player.current?.stop();
    setStopped(true);
  }
  const canSpeak = speechSupported();
  const again = () => onRestart(canSpeak ? { kind: "mic" } : { kind: "typed", text: "" });

  // Before the card is up, the captions carry what has been heard so far (typed text builds up at speaking pace; the
  // words not yet "heard" hold their place invisibly, so the line never reflows as they fade in).
  const capWords = !revealed && start.kind === "typed" ? firstWords.map((text, i) => ({ text, state: i < heardShown ? ("heard" as const) : ("upcoming" as const) })) : view.words;

  return (
    <div ref={root} className={`screen live${revealed ? "" : " listening"}${done ? " done" : ""}`}>
      <header className="topbar">
        <button className="circbtn" aria-label="Close" title="Close" onClick={onHome}><CloseIcon /></button>
        <Island tone={tone} label={label} detail={detail} />
        <button className={`circbtn${prefs.captions ? " on" : ""}`} aria-label="Captions" aria-pressed={prefs.captions} title="Captions" onClick={() => setPrefs({ captions: !prefs.captions })}>
          <CaptionsIcon off={!prefs.captions} />
        </button>
      </header>

      {banner ? (
        <div className="banner" role="alert">
          <span>{banner}</span>
          {micRetry ? <button className="retry" onClick={startMic}>Retry</button> : null}
        </div>
      ) : null}

      <section className="stagewrap">
        <div className="halo" data-level aria-hidden="true" />
        <SignerStage onReady={onPlayer} on={revealed} label={blocked || latestError ? "Signing paused; caption shown" : "Signer"}
          safety={safety} error={latestError ? { caption: phrases.at(-1)?.text ?? "", message: latestError } : undefined}>
          {waveGone ? null : (
            <div className="card-wave" aria-hidden="true">
              <Wave level={0.9} talking={!revealed && (micOn || start.kind === "typed")} getLevel={micOn ? getLevel : undefined} />
            </div>
          )}
          {generating ? <span className="gen-chip" role="status">{generating}</span> : null}
        </SignerStage>
      </section>

      <section className={`capzone${prefs.captions ? "" : " hidden-cap"}`} aria-label="Captions">
        <Captions words={capWords} now={view.now} lines={2} placeholder={!revealed && micOn ? "Start speaking…" : undefined} />
        {revealed ? <Hints u={latestUnsupported} f={latestFingerspell} /> : null}
        {done ? (
          <p className="sumline sr-only">
            {latestError ? "Signing unavailable: server connection failed." : blocked ? "Caption only: no signing for this message." : `Signed: ${total} sign${total === 1 ? "" : "s"}, ${Math.round(secs)} seconds.`}
          </p>
        ) : null}
      </section>

      <footer className={`controls${typing ? " typing" : ""}`}>
        {typing ? (
          <div className="typerow">
            <button className="circbtn" aria-label="Close keyboard" title="Close" onClick={() => setTyping(false)}><CloseIcon /></button>
            <TypeBox onSubmit={submit} autoFocus placeholder="Type to sign" />
          </div>
        ) : (
          <>
            <button className="circbtn lg" id="typebtn" aria-label="Type" title="Type" onClick={() => setTyping(true)}><KeyboardIcon /></button>
            {done ? (
              <button className="primebtn" id="again" aria-label={canSpeak ? "Listen again" : "Type again"} title={canSpeak ? "Listen again" : "Type again"} onClick={again}>
                <span className="swap" key="again">{canSpeak ? <MicIcon /> : <KeyboardIcon />}</span>
              </button>
            ) : (
              <button className="primebtn" id="stop" aria-label="Stop" title="Stop" onClick={stop}><span className="swap" key="stop"><StopIcon /></span></button>
            )}
            <button className="circbtn lg later" id="replay" aria-label="Replay" title="Replay" onClick={() => player.current?.replay()} disabled={!done || !total || !!blocked || !!latestError}><ReplayIcon /></button>
          </>
        )}
      </footer>
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
