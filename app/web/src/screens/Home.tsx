// Home: the wordmark, one big listen orb, a quiet way to type, and the other direction (sign to speak).
import { useState } from "react";
import { copy } from "@signlayer/core";
import { GearIcon, HandIcon, Mark, MicIcon, Wordmark } from "../components/Icons";
import { TypeBox } from "../components/TypeBox";
import { ARTIFACT } from "../config";
import { SUGGESTIONS } from "../artifact/suggestions";

export function Home({ canListen, onListen, onType, onSettings, onSign }: { canListen: boolean; onListen(): void; onType(text: string): void; onSettings(): void; onSign(): void }) {
  const [typing, setTyping] = useState(!canListen);
  return (
    <div className="screen home">
      <header className="topbar">
        <span className="brand"><Mark /><Wordmark /></span>
        <button className="circbtn ghost" aria-label="Settings" title="Settings" onClick={onSettings}><GearIcon /></button>
      </header>

      <section className="hero">
        <h1 className="title">Hear anything.<br />See it signed.</h1>
        <div className="orbzone">
          <div className="aura" aria-hidden="true" />
          <button id="listen" className={`orb${canListen ? "" : " off"}`} aria-label={copy.listen} onClick={() => (canListen ? onListen() : setTyping(true))}><MicIcon /></button>
        </div>
        {canListen ? <p className="orb-label">{copy.listen}</p> : <p className="orb-label sub">{ARTIFACT ? "Mic works in the full app." : "Listening needs Chrome or Edge. Type instead."}</p>}
        <div className="alt">
          {typing ? (
            <TypeBox onSubmit={onType} autoFocus placeholder="Type a sentence to sign" />
          ) : (
            <button className="quiet" id="type" onClick={() => setTyping(true)}>Type instead</button>
          )}
        </div>
        {ARTIFACT && typing ? (
          <div className="suggest" aria-label="Try a sentence">
            {SUGGESTIONS.map((s, i) => <button key={s} type="button" className="chip" style={{ ["--i" as string]: i }} onClick={() => onType(s)}>{s}</button>)}
          </div>
        ) : null}
      </section>

      <footer className="homefoot">
        <a className="capsule" id="sign" href="#/sign" onClick={(e) => { e.preventDefault(); onSign(); }}><HandIcon />Sign to speak</a>
      </footer>
    </div>
  );
}
