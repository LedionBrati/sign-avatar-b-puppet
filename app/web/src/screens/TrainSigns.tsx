// "Train my signs" (#/train): record a few reps of each demo sign so sign -> voice knows THIS signer.
// Pick signs, then per rep: the word, a 3-2-1 countdown, ~3.5 s to sign it once. The shared segmenter
// (app/core/src/segment.ts) trims each rep to the sign itself; it goes to POST /api/enroll (stored by app/recognizer
// in out/enroll/<profile>/, hands + pose only, no face). One "no sign" rep (hands resting / fidgeting, 4 s) teaches the
// model what is not a sign. Then POST /api/train fits the profile's model in a few seconds, and Sign to speak uses it
// (closed demo vocabulary + the GISLR prior, "unsure" when nothing fits).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_SIGNS, NONE_SIGN, SignApiError, createSignClient, labelText, packFrame, packSegment, type EnrollInfo } from "@flux/core";
import { apiBase } from "../config";
import { CloseIcon } from "../components/Icons";
import { createTracker, drawOverlay, type Tracker } from "../lib/holistic";
import { createSegmenter, type SegmentDone } from "../lib/segmenter";
import { getPrefs, setPrefs } from "../lib/prefs";

const COUNT_MS = 2400; // 3-2-1
const WINDOW_MS = 3500; // time to sign one rep
const IDLE_MS = 4000; // the "no sign" rep
type Step = { label: string; rep: number };
type Phase = "pick" | "count" | "sign" | "saving" | "training" | "done";

export function TrainSigns({ onDone }: { onDone(): void }) {
  const client = useMemo(() => createSignClient(apiBase(), { timeoutMs: 60_000 }), []);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tracker = useRef<Tracker | null>(null);
  const alive = useRef(true);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [profile, setProfile] = useState(getPrefs().signProfile && getPrefs().signProfile !== "demo" ? getPrefs().signProfile! : "me");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(getPrefs().signVocab ?? DEMO_SIGNS));
  const [reps, setReps] = useState(4);
  const [info, setInfo] = useState<EnrollInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [plan, setPlan] = useState<Step[]>([]);
  const [at, setAt] = useState(0);
  const [count, setCount] = useState(3);
  const [note, setNote] = useState<string | null>(null);
  const [hands, setHands] = useState(false);
  const run = useRef(0); // bumped by Start / Stop: timers of an older run do nothing

  // Camera + hand tracking (same as Sign to speak).
  useEffect(() => {
    alive.current = true;
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } })
      .then(async (s) => { if (!alive.current) { s.getTracks().forEach((t) => t.stop()); return; } video.current!.srcObject = s; await video.current!.play().catch(() => {}); })
      .catch((e) => setErr(`The camera didn't start (${(e as Error).message}).`));
    createTracker().then((t) => { if (!alive.current) { t.close(); return; } tracker.current = t; setReady(true); })
      .catch((e) => setErr(`Hand tracking didn't load (${(e as Error).message}).`));
    return () => {
      alive.current = false;
      (video.current?.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
      tracker.current?.close();
    };
  }, []);
  const refresh = useCallback((p: string) => { client.enrollInfo(p).then((i) => alive.current && setInfo(i)).catch(() => setInfo(null)); }, [client]);
  useEffect(() => { if (/^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile)) refresh(profile); }, [profile, refresh]);

  // Per frame: draw, and feed the segmenter / the idle recorder while a rep is being recorded.
  const onFrame = useRef<((f: ReturnType<Tracker["detect"]>, t: number) => void) | null>(null);
  useEffect(() => {
    if (!ready) return;
    const v = video.current!, c = canvas.current!, ctx = c.getContext("2d")!;
    let stop = false, lastT = -1, handle = 0, saw = false;
    const tick = () => {
      if (stop) return;
      const t = tracker.current;
      if (t && v.readyState >= 2 && v.currentTime !== lastT) {
        lastT = v.currentTime;
        if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
        const now = performance.now();
        const f = t.detect(v, now);
        drawOverlay(ctx, f, t.connections);
        onFrame.current?.(f, now);
        const h = Boolean(f.leftHand?.length || f.rightHand?.length);
        if (h !== saw) { saw = h; setHands(h); }
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => { stop = true; cancelAnimationFrame(handle); };
  }, [ready]);

  const save = useCallback(async (label: string, frames: Float32Array) => {
    setPhase("saving");
    try {
      const i = await client.enroll(profile, label, frames);
      if (!alive.current) return;
      setInfo(i);
      setNote(null);
      setAt((k) => k + 1);
    } catch (e) {
      setNote(e instanceof SignApiError ? e.message : `Couldn't save (${(e as Error).message}). Is the server running?`);
    }
    setPhase("count");
  }, [client, profile]);

  // One rep: countdown, then record. A sign: the first cut the segmenter finishes (or whatever was signed when the
  // window ends). The "no sign" rep: all frames for IDLE_MS.
  useEffect(() => {
    if (phase !== "count" || at >= plan.length) return;
    const step = plan[at]!;
    const r = run.current;
    setCount(3);
    const t1 = setTimeout(() => setCount(2), COUNT_MS / 3), t2 = setTimeout(() => setCount(1), (2 * COUNT_MS) / 3);
    const t3 = setTimeout(() => {
      setPhase("sign");
      if (step.label === NONE_SIGN) {
        const buf: Float32Array[] = [];
        onFrame.current = (f) => { buf.push(packFrame(f)); };
        setTimeout(() => { if (run.current !== r) return; onFrame.current = null; if (buf.length > 8) void save(NONE_SIGN, packSegment(buf.slice(-384))); else { setNote("No frames. Is the camera on?"); setPhase("count"); } }, IDLE_MS);
        return;
      }
      let got: SegmentDone | null = null;
      const seg = createSegmenter((s) => { if (s.count && (!got || s.count > got.count)) got = s; }, () => {}, { continuous: true });
      seg.arm();
      onFrame.current = (f, t) => { seg.push(f, t); };
      setTimeout(() => {
        if (run.current !== r) return;
        seg.stop();
        onFrame.current = null;
        const g = got as SegmentDone | null;
        if (g?.count) void save(step.label, g.frames);
        else { setNote("Didn't catch a sign. Raise your hands into view and sign once after the countdown."); setPhase("count"); }
      }, WINDOW_MS);
    }, COUNT_MS);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [phase, at, plan, save]);

  // All reps recorded: train.
  useEffect(() => {
    if (phase !== "count" || !plan.length || at < plan.length) return;
    setPhase("training");
    client.train(profile)
      .then((i) => { if (!alive.current) return; setInfo(i); setPhase("done"); setPrefs({ signProfile: profile, signVocab: [...picked], closedVocab: true }); })
      .catch((e) => { setNote(`Training failed: ${(e as Error).message}`); setPhase("pick"); });
  }, [phase, at, plan, client, profile, picked]);

  const start = () => {
    const signs = DEMO_SIGNS.filter((s) => picked.has(s));
    const steps: Step[] = [];
    for (let r = 0; r < reps; r++) for (const s of signs) steps.push({ label: s, rep: r + 1 }); // rounds, so reps vary
    steps.push({ label: NONE_SIGN, rep: 1 });
    run.current++;
    setPlan(steps); setAt(0); setNote(null); setPhase("count");
  };
  const toggle = (s: string) => setPicked((p) => { const n = new Set(p); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const step = plan[at];
  const word = step ? (step.label === NONE_SIGN ? "No sign" : labelText(step.label)) : "";
  const okProfile = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(profile);

  return (
    <div className="screen signsp train">
      <header className="topbar">
        <button className="circbtn" aria-label="Close" title="Close" onClick={onDone}><CloseIcon /></button>
        <span className="traintitle">Train my signs</span>
        <span />
      </header>
      {err ? <div className="banner" role="alert"><span>{err}</span></div> : null}

      <section className="stagewrap">
        <div className={`camcard${phase === "sign" ? " rec" : ""}`}>
          <video ref={video} className="cam" muted playsInline autoPlay />
          <canvas ref={canvas} className="cam overlay" />
          {phase === "count" || phase === "sign" || phase === "saving" ? (
            <div className="trainprompt" aria-live="polite">
              <b>{word}</b>
              <span>{phase === "count" ? count : phase === "sign" ? (step?.label === NONE_SIGN ? "Hands down or fidget, don't sign" : "Sign it now") : "Saving…"}</span>
              <em>{at + 1} / {plan.length}</em>
            </div>
          ) : null}
          <span className={`camstatus${hands ? " on" : ""}`}>{!ready ? "Loading hand tracking…" : phase === "training" ? "Training…" : hands ? "Hands found" : "Raise your hands into view"}</span>
        </div>
      </section>

      <section className="sentzone trainpanel">
        {note ? <p className="hint signhint">{note}</p> : null}
        {phase === "pick" ? (
          <>
            <div className="group"><div className="row"><span>Name</span><input aria-label="Profile name" value={profile} onChange={(e) => setProfile(e.target.value.toLowerCase())} /></div>
              <div className="row"><span>Reps per sign</span>{[3, 4, 5].map((n) => <button key={n} className={`btn${reps === n ? " primary" : ""}`} onClick={() => setReps(n)}>{n}</button>)}</div></div>
            <div className="trainsigns" aria-label="Signs to train">
              {DEMO_SIGNS.map((s) => (
                <button key={s} className={`cand${picked.has(s) ? " on" : ""}`} onClick={() => toggle(s)} aria-pressed={picked.has(s)}>
                  {labelText(s)}{info?.reps[s] ? <em>{info.reps[s]}</em> : null}
                </button>
              ))}
            </div>
            <div className="caprow">
              <button className="capbtn speak" disabled={!ready || !picked.size || !okProfile} onClick={start}>Record {picked.size * reps + 1} reps</button>
              {info?.trained ? <button className="capbtn" onClick={() => { setPrefs({ signProfile: profile, signVocab: [...picked], closedVocab: true }); onDone(); }}>Use saved</button> : null}
              {info && Object.keys(info.reps).length ? <button className="capbtn" onClick={() => { void client.unenroll(profile).then(() => refresh(profile)); }}>Delete reps</button> : null}
            </div>
          </>
        ) : phase === "done" ? (
          <>
            <p className="hint">Trained on {info?.model?.own_reps ?? 0} of your reps in {((info?.model?.train_ms ?? 0) / 1000).toFixed(1)} s
              {info?.model?.loo ? <>; your reps match each other {info.model.loo.right}/{info.model.loo.of}</> : null}.</p>
            <div className="caprow"><button className="capbtn speak" onClick={onDone}>Start signing</button><button className="capbtn" onClick={() => setPhase("pick")}>Record more</button></div>
          </>
        ) : (
          <div className="caprow"><button className="capbtn" onClick={() => { run.current++; onFrame.current = null; setPlan([]); setPhase("pick"); }}>Stop</button></div>
        )}
      </section>
    </div>
  );
}
