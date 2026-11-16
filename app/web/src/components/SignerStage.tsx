// The signer card: two stacked videos driven by GaplessPlayer, shown whole (the clips are 3:4 and the card is 3:4,
// so head and both hands are always in frame), on the clips' own studio backdrop so nothing ever flashes black.
// Over them, the instant 3D signer's canvas (same 3:4 stage): HybridPlayer crossfades between the two styles, one
// style per phrase.
import { useEffect, useRef, type ReactNode } from "react";
import type { SigningSafety } from "@signlayer/core";
import { GaplessPlayer } from "../lib/player";
import { HybridPlayer } from "../lib/hybrid";
import { getSigner3D } from "../lib/signer3d";

export function SignerStage({ onReady, on, label, safety, error, children }: {
  onReady(p: HybridPlayer | null): void; on: boolean; label: string; safety?: SigningSafety; error?: { caption: string; message: string }; children?: ReactNode;
}) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const layer3d = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const clips = new GaplessPlayer([a.current!, b.current!]);
    const p = new HybridPlayer(clips, getSigner3D);
    // The canvas belongs to the page-wide 3D signer; it is moved here (its WebGL context survives the move).
    const mount = () => { const c = getSigner3D().canvas; if (c.parentElement !== layer3d.current) layer3d.current?.appendChild(c); };
    mount();
    p.onMode = (m) => { mount(); if (stage.current) stage.current.dataset.mode = m; };
    onReady(p);
    return () => { onReady(null); p.dispose(); clips.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const blocked = error || (safety && safety.status !== "fully_supported");
  return (
    <div className={`signer-card${on ? " on" : ""}`}>
      <div ref={stage} className={`sl-signer${blocked ? " blocked" : ""}`} data-mode="clips" role="img" aria-label={label}>
        <video ref={a} muted playsInline preload="auto" />
        <video ref={b} muted playsInline preload="auto" />
        <div ref={layer3d} className="sl-3d" aria-hidden="true" />
      </div>
      {children}
      {error ? (
        <div className="safety-card" role="status" aria-live="polite">
          <strong>Signing unavailable</strong>
          <p className="safety-caption">{error.caption}</p>
          <p className="safety-reason">The sign server could not be reached. Try again when it reconnects.</p>
        </div>
      ) : blocked && safety ? (
        <div className="safety-card" role="status" aria-live="polite">
          <strong>{safety.status === "needs_confirmation" ? "Meaning needs confirmation" : "Caption only"}</strong>
          <p className="safety-caption">{safety.caption}</p>
          {safety.reasons.map((reason, i) => (
            <p className="safety-reason" key={`${reason.code}-${i}`}>
              {reason.tokens.length ? <b>{reason.tokens.join(", ")}: </b> : null}{reason.next_action}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
