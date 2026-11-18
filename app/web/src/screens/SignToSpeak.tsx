// Sign -> speak, continuous: the front camera, MediaPipe Holistic landmarks, always reading while the camera is on
// (no tap per sign). The screen is the UI; the work is in ./signToSpeak/:
//   useCamera      camera + MediaPipe, one detection per video frame
//   useSignReader  the rest-based segmenter (lib/segmenter.ts on app/core/src/segment.ts) -> POST /api/recognize
//   useSentence    the sentence (POST /api/compose in the background, else the local rules) and when it is spoken
//   useSpeaker     natural voice (POST /api/speak) or the device voice; embed.ts posts to the phone app
//   config.ts      the tuning constants
// Closed vocabulary (prefs.closedVocab, the default): the demo signs only, read by the profile's personal model
// ("Train my signs", #/train; profile "demo" = the generic one) + the GISLR prior; a segment can hold several signs
// (signs[]); "no sign" pieces are dropped, unsure ones kept with the hint and the chips. Top-1 is appended (top-3 chips
// to correct it), and the words show live in the sentence box. Reading goes on while it speaks.
// Pause/Resume stops reading; Undo/Clear/edit + Speak stay available.
// "#/sign?embed=1" is the same screen for the phone app's WebView: results also go to window.ReactNativeWebView.
import { useEffect, useMemo, useState } from "react";
import { DEMO_SIGNS, SignApiError, createSignClient, labelText, type RecognizeMode } from "@flux/core";
import { apiBase, apiLabel } from "../config";
import { ClockIcon, CloseIcon, GridIcon, HandIcon, PauseIcon, SpeakerIcon, UndoIcon } from "../components/Icons";
import { Segmented } from "../components/Segmented";
import { SIGN_VOCAB } from "../lib/vocab";
import { navigate } from "../lib/route";
import { setPrefs, usePrefs } from "../lib/prefs";
import { unlockVoice } from "../lib/voice";
import { CLIENT_TIMEOUT_MS } from "./signToSpeak/config";
import { useEmbedSentence } from "./signToSpeak/embed";
import { useCamera } from "./signToSpeak/useCamera";
import { useSentence, type Edit } from "./signToSpeak/useSentence";
import { useSignReader } from "./signToSpeak/useSignReader";
import { useSpeaker } from "./signToSpeak/useSpeaker";

/** The recognizer's errors as one banner line. */
function errorBanner(e: unknown): string {
  const err = e as Error;
  if (err instanceof SignApiError && err.status === 503) return "The sign recognizer is offline (503). Start app/recognizer, then try again.";
  if (err instanceof SignApiError && err.status === 404) return `This server has no sign recognizer yet (${apiLabel()}/api/recognize is 404). Try npm run dev:mock.`;
  if (err instanceof SignApiError) return `The recognizer failed: ${err.message}`;
  return `Can't reach the server at ${apiLabel()}. Is it running? (${err.message})`;
}

export function SignToSpeak({ embed, onHome }: { embed: boolean; onHome(): void }) {
  const client = useMemo(() => createSignClient(apiBase(), { timeoutMs: CLIENT_TIMEOUT_MS }), []);
  const prefs = usePrefs();
  const closed = prefs.closedVocab !== false;
  const vocab = useMemo(() => (prefs.signVocab?.length ? prefs.signVocab : [...DEMO_SIGNS]), [prefs.signVocab]);

  const [paused, setPaused] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<RecognizeMode>("sign");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"signs" | "history" | null>(null);

  const camera = useCamera({ onFrame: (f, t) => reader.push(f, t), onError: setBanner });
  const { video, canvas, cam, camMsg, track, fps, hands, startCam, ready } = camera;
  const reader = useSignReader({
    client, mode, reading: ready && !paused, fpsRef: camera.fpsRef, setHint,
    closed: { on: closed, profile: prefs.signProfile || "demo", vocab },
    onError: (e) => setBanner(errorBanner(e)), onOk: () => setBanner(null),
  });
  const { items, setItems, seg, pending } = reader;
  const speaker = useSpeaker({ client, embed, setHint });
  const { lastSaid, history } = speaker;
  const { sentence, composing, speak, fresh, aiOn } = useSentence({
    client, items, epoch: reader.epoch, freshSigns: reader.fresh, seg, pending, restFrom: reader.restFrom,
    paused, editing, edit, setEdit, setHint, speakText: speaker.speakText, said: speaker.said,
  });
  useEmbedSentence(embed, sentence);

  useEffect(() => {
    let alive = true;
    client.health().then((h) => {
      aiOn.current = h.compose === "ready";
      speaker.voiceOn.current = h.speak === "ready";
      if (alive && h.recognizer === "down") setBanner("The sign recognizer is offline. Start app/recognizer; signing won't work until then.");
    }).catch(() => {});
    return () => { alive = false; };
  }, [client, aiOn, speaker.voiceOn]);

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
  const clear = fresh;

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
        <div className={`camcard${seg === "recording" ? " rec" : ""}`} title={ready ? `${fps.toFixed(0)} fps · MediaPipe on ${camera.delegate() ?? "?"}` : undefined}>
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
