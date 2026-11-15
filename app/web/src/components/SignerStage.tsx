// The signer inside a lane: halo + two stacked videos driven by GaplessPlayer, framed by the radial mask (.sl-signer).
import { useEffect, useRef } from "react";
import { GaplessPlayer } from "../lib/player";

export function SignerStage({ onReady, on, label }: { onReady(p: GaplessPlayer | null): void; on: boolean; label: string }) {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const p = new GaplessPlayer([a.current!, b.current!]);
    onReady(p);
    return () => { onReady(null); p.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="sl-halo" />
      <div className={`sl-signer${on ? " on" : ""}`} role="img" aria-label={label}>
        <video ref={a} muted playsInline preload="auto" />
        <video ref={b} muted playsInline preload="auto" />
      </div>
    </>
  );
}
