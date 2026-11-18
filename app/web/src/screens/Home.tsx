// Home: the mark, one big glass listen orb with the glowing voice line running through it, and a thumb-height dock
// (type / sign to speak). No headline: the orb and the line are the whole page.
import { useCallback, useState } from "react";
import { copy } from "@flux/core";
import { CloseIcon, GearIcon, HandIcon, KeyboardIcon, Mark, MicIcon, Wordmark } from "../components/Icons";
import { TypeBox } from "../components/TypeBox";
import { Wave } from "../components/Wave";
import { ARTIFACT } from "../config";
import { SUGGESTIONS } from "../artifact/suggestions";

/** A slow, low breath for the idle line (0..1): it shimmers without pretending to hear anything. */
const idle = () => { const t = performance.now(); return 0.16 + 0.08 * Math.sin(t / 1100) + 0.04 * Math.sin(t / 370 + 1.7); };

export function Home({ canListen, onListen, onType, onSettings, onSign }: { canListen: boolean; onListen(): void; onType(text: string): void; onSettings(): void; onSign(): void }) {
  const [typing, setTyping] = useState(!canListen);
  const getLevel = useCallback(idle, []);
  return (
    <div className="screen home">
      <header className="topbar">
        <span className="brand"><Mark /><Wordmark /></span>
        <button className="circbtn" aria-label="Settings" title="Settings" onClick={onSettings}><GearIcon /></button>
      </header>

      <section className="hero">
        <div className="orbzone">
          <div className="orbwave" aria-hidden="true"><Wave level={0.95} talking getLevel={getLevel} /></div>
          <div className="aura" aria-hidden="true" />
          <div className="orbglass" aria-hidden="true" />
          <div className="orbring" aria-hidden="true" />
          <button id="listen" className={`orb${canListen ? "" : " off"}`} aria-label={canListen ? copy.listen : "Listening is not available here"}
            onClick={() => (canListen ? onListen() : setTyping(true))}><MicIcon /></button>
        </div>
        <p className={`orb-label${canListen ? "" : " sub"}`}>{canListen ? copy.listen : ARTIFACT ? "Mic works in the full app" : "Type instead: listening needs Chrome or Edge"}</p>
      </section>

      <footer className="dock">
        {ARTIFACT && typing ? (
          <div className="suggest" aria-label="Try a sentence">
            {SUGGESTIONS.map((s, i) => <button key={s} type="button" className="chip" style={{ ["--i" as string]: i }} onClick={() => onType(s)}>{s}</button>)}
          </div>
        ) : null}
        {typing ? (
          <div className="dockrow typing">
            {canListen ? <button className="circbtn" aria-label="Close keyboard" title="Close" onClick={() => setTyping(false)}><CloseIcon /></button> : null}
            <TypeBox onSubmit={onType} autoFocus placeholder="Type to sign" />
          </div>
        ) : (
          <div className="dockrow">
            <button className="pill" id="type" onClick={() => setTyping(true)}><KeyboardIcon /><span>Type</span></button>
            <a className="pill" id="sign" href="#/sign" onClick={(e) => { e.preventDefault(); onSign(); }}><HandIcon /><span>Sign to speak</span></a>
          </div>
        )}
      </footer>
    </div>
  );
}
