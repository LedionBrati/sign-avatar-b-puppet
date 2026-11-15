import { useState } from "react";
import { copy } from "@signlayer/core";
import { ExtIcon, GearIcon, Mark, MicIcon, Wordmark } from "../components/Icons";
import { TypeBox } from "../components/TypeBox";
import { Wave } from "../components/Wave";
import { HandIcon } from "./SignToSpeak";

export function Home({ canListen, onListen, onType, onSettings, onSign }: { canListen: boolean; onListen(): void; onType(text: string): void; onSettings(): void; onSign(): void }) {
  const [typing, setTyping] = useState(!canListen);
  const engineeringPreview = import.meta.env.VITE_ENGINEERING_PREVIEW === "1";
  return (
    <div className="screen home field">
      <div className="g live" />
      <div className="bar">
        <Mark />
        <Wordmark />
        <button className="iconbtn" aria-label="Settings" onClick={onSettings}><GearIcon /></button>
      </div>
      <div className="headline">
        <h1>{engineeringPreview ? <>Engineering<br />preview.</> : <>Hear anything.<br />See it signed.</>}</h1>
        <p>{engineeringPreview ? "Web interface only. Signing and sign-to-voice need an online API and authorized clips." : copy.sub}</p>
      </div>
      <div className="orbwrap">
        <div className="orbbox" aria-hidden="true" onClick={() => (canListen ? onListen() : setTyping(true))}>
          <Wave className="idlewave" level={0.22} talking />
        </div>
        {canListen ? (
          <button className="listenbtn" id="listen" onClick={onListen}><MicIcon />{copy.listen}</button>
        ) : (
          <p className="any" style={{ margin: 0 }}>Live listening needs Chrome or Edge. Type instead:</p>
        )}
        {typing ? (
          <TypeBox onSubmit={onType} autoFocus={canListen} placeholder="Type a sentence to sign" />
        ) : (
          <button className="textlink" id="type" onClick={() => setTyping(true)}>Type instead</button>
        )}
        <a className="pill sm signentry" id="sign" href="#/sign" onClick={(e) => { e.preventDefault(); onSign(); }}><HandIcon />Sign to speak</a>
      </div>
      <p className="any">{engineeringPreview ? "Use Settings to connect the sign server when it is available." : copy.any}</p>
      {!engineeringPreview && <div className="extcard">
        <span className="exticon"><ExtIcon /></span>
        <span className="exttxt"><b>{copy.extTitle}</b><span>{copy.extSub}</span></span>
        <span className="extgo" aria-hidden="true">›</span>
      </div>}
    </div>
  );
}
