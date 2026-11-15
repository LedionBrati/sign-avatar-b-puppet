// One frosted card per speaker (prototype ".lane"). Single speaker by default; ready for N (lit / quiet / unseen states).
import type { CSSProperties, ReactNode } from "react";
import { speakers } from "@signlayer/core";

export type LaneMode = "unseen" | "lit" | "quiet" | "rest";

export function Lane({ index, label, mode, arrive, speaking, stage, caption }: {
  index: number; label: string; mode: LaneMode; arrive?: boolean; speaking?: boolean; stage: ReactNode; caption?: ReactNode;
}) {
  const s = speakers[index % speakers.length]!;
  const style = { "--spk": s.spk, "--glow": s.glow } as CSSProperties;
  return (
    <section className={`lane sl-card ${mode === "rest" ? "" : mode}${arrive ? " arrive" : ""}`} style={style} aria-hidden={mode === "unseen"} data-s={index}>
      <div className="stage">
        {stage}
        <span className="sl-chip"><i />{label}<em>&nbsp;· {speaking ? "Signing" : "Speaking"}</em></span>
      </div>
      {caption}
      <i className="ring" />
    </section>
  );
}
