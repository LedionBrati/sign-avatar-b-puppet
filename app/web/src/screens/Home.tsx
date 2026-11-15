import { useState } from "react";
import { copy } from "@signlayer/core";
import { ExtIcon, GearIcon, Mark, MicIcon, Wordmark } from "../components/Icons";
import { TypeBox } from "../components/TypeBox";
import { Wave } from "../components/Wave";

export function Home({ canListen, onListen, onType, onSettings }: { canListen: boolean; onListen(): void; onType(text: string): void; onSettings(): void }) {
  const [typing, setTyping] = useState(!canListen);
  return (
    <div className="screen home field">
      <div className="g live" />
      <div className="bar">
        <Mark />
        <Wordmark />
        <button className="iconbtn" aria-label="Settings" onClick={onSettings}><GearIcon /></button>
      </div>
      <div className="headline">
        <h1>Hear anything.<br />See it signed.</h1>
        <p>{copy.sub}</p>
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
      </div>
      <p className="any">{copy.any}</p>
      <div className="extcard">
        <span className="exticon"><ExtIcon /></span>
        <span className="exttxt"><b>{copy.extTitle}</b><span>{copy.extSub}</span></span>
        <span className="extgo" aria-hidden="true">›</span>
      </div>
    </div>
  );
}
