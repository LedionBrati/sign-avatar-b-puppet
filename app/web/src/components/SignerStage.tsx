// The signer inside a lane: halo + two stacked videos driven by GaplessPlayer, framed by the radial mask (.sl-signer).
import { useEffect, useRef } from "react";
import type { SigningSafety } from "@signlayer/core";
import { GaplessPlayer } from "../lib/player";

export function SignerStage({ onReady, on, label, safety, error }: { onReady(p: GaplessPlayer | null): void; on: boolean; label: string; safety?: SigningSafety; error?: { caption: string; message: string } }) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const p = new GaplessPlayer([a.current!, b.current!]);
    onReady(p);
    return () => { onReady(null); p.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const blocked = error || (safety && safety.status !== "fully_supported");
  return (
    <>
      <div className="sl-halo" />
      <div className={`sl-signer${on ? " on" : ""}${blocked ? " blocked" : ""}`} role="img" aria-label={label}>
        <video ref={a} muted playsInline preload="auto" />
        <video ref={b} muted playsInline preload="auto" />
      </div>
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
    </>
  );
}
