// Caption sheet (prototype ".sl-cap"): words fade in as heard, go solid when signed; a tinted highlight glides to the word
// being signed, and the sheet rolls up so the newest line is always in view. Words we can't sign stay muted, never faked.
import { useLayoutEffect, useRef } from "react";
import type { CapWord } from "../lib/session";

const HINT = { unsupported: "Can't sign yet", fingerspell: "Fingerspelling not available yet" } as const;

export function Captions({ words, now, lines = 2 }: { words: CapWord[]; now: number; lines?: number }) {
  const roll = useRef<HTMLDivElement>(null);
  const hl = useRef<HTMLElement>(null);
  const cap = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const r = roll.current, h = hl.current;
    if (!r || !h) return;
    const ws = [...r.querySelectorAll<HTMLElement>(".w")];
    const w = now >= 0 ? ws[now] : undefined;
    if (w) {
      const pad = 4;
      h.style.transform = `translate(${w.offsetLeft - pad}px, ${w.offsetTop - 1}px)`;
      h.style.width = `${w.offsetWidth + pad * 2}px`;
      h.style.height = `${w.offsetHeight + 2}px`;
      h.classList.add("show");
    } else h.classList.remove("show");
    // Follow: keep the newest visible word (or the signed one, if it's further down) on the last line.
    let last = -1;
    words.forEach((x, i) => { if (x.state !== "upcoming") last = i; });
    const target = ws[Math.max(0, Math.max(last, now))];
    const lh = ws[0]?.offsetHeight || 26;
    const top = target ? Math.max(0, target.offsetTop - (lines - 1) * lh) : 0;
    r.style.transform = `translateY(${-top}px)`;
  }, [words, now, lines]);

  return (
    <div ref={cap} className="sl-cap" style={{ ["--lines" as string]: lines }} aria-live="off">
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
      </div>
    </div>
  );
}
