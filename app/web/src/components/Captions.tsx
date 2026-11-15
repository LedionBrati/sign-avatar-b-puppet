// The live transcript, set large under the signer: words blur in as they are heard (readable straight away), go
// solid once signed, and a cobalt highlight glides to the word being signed. The text rolls up so the newest
// `lines` stay in view. `plain` drops the signing highlight and keeps just the transcript.
// Words we can't sign stay dotted, never faked.
import { useLayoutEffect, useRef } from "react";
import type { CapWord } from "../lib/session";

const HINT = { unsupported: "", fingerspell: "" } as const;

export function Captions({ words, now, lines = 2, placeholder, plain }: { words: CapWord[]; now: number; lines?: number; placeholder?: string; plain?: boolean }) {
  const roll = useRef<HTMLDivElement>(null);
  const hl = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const r = roll.current, h = hl.current;
    if (!r || !h) return;
    const ws = [...r.querySelectorAll<HTMLElement>(".w")];
    const w = now >= 0 ? ws[now] : undefined;
    if (w) {
      const px = Math.round(w.offsetHeight * 0.16), py = Math.round(w.offsetHeight * 0.02);
      h.style.transform = `translate(${w.offsetLeft - px}px, ${w.offsetTop - py}px)`;
      h.style.width = `${w.offsetWidth + px * 2}px`;
      h.style.height = `${w.offsetHeight + py * 2}px`;
      h.classList.add("show");
    } else h.classList.remove("show");
    // Follow: keep the newest visible word (or the signed one, if it's further down) on the last line.
    let last = -1;
    words.forEach((x, i) => { if (x.state !== "upcoming") last = i; });
    const target = ws[Math.max(0, Math.max(last, now))];
    const lh = ws[0]?.offsetHeight || 32;
    const top = target ? Math.max(0, target.offsetTop - (lines - 1) * lh) : 0;
    r.style.transform = `translateY(${-top}px)`;
  }, [words, now, lines]);

  return (
    <div className={`sl-cap${plain ? " plain" : ""}`} style={{ ["--lines" as string]: lines }} aria-live="off">
      <div className="view">
        <div className="roll" ref={roll}>
          <i className="hl" ref={hl} />
          {words.map((w, i) => (
            <span key={i}>
              <span className={`w ${w.state}${w.state === "now" ? " signed" : ""}${w.nosign ? " nosign" : ""}`} title={w.nosign ? HINT[w.nosign] : undefined}>
                {w.text}
              </span>{" "}
            </span>
          ))}
        </div>
        {!words.length && placeholder ? <span className="placeholder">{placeholder}</span> : null}
      </div>
    </div>
  );
}
