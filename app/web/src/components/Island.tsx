// The status capsule (Dynamic-Island style). It morphs: the width springs to fit the new content while the label
// cross-blurs in. Tones: live (level bars), sign (pulsing accent + gloss), busy (spinner), done, warn, rec, idle.
import { useLayoutEffect, useRef } from "react";
import { CheckIcon } from "./Icons";

export type IslandTone = "idle" | "live" | "sign" | "busy" | "done" | "warn" | "rec";

export function Island({ tone, label, detail, className = "" }: { tone: IslandTone; label: string; detail?: string; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    const fit = () => { o.style.width = `${Math.ceil(i.getBoundingClientRect().width)}px`; };
    fit();
    // First paint: no morph from zero. Afterwards every change springs.
    if (!o.dataset.ready) requestAnimationFrame(() => { o.dataset.ready = "1"; });
    const ro = new ResizeObserver(fit);
    ro.observe(i);
    return () => ro.disconnect();
  }, [tone, label, detail]);
  return (
    <div ref={outer} className={`island ${tone} ${className}`} data-state={tone} role="status" aria-live="polite">
      <span ref={inner} className="island-in">
        <span key={`${tone}:${label}`} className="island-main">
          <Glyph tone={tone} />
          <span className="island-label">{label}</span>
        </span>
        {detail ? <b key={detail} className="island-detail">{detail}</b> : null}
      </span>
    </div>
  );
}

function Glyph({ tone }: { tone: IslandTone }) {
  if (tone === "live") return <span className="ig-bars" aria-hidden="true">{[0.55, 1, 0.75, 0.4].map((k, i) => <i key={i} data-level style={{ ["--k" as string]: k, ["--d" as string]: `${i * -0.18}s` }} />)}</span>;
  if (tone === "busy") return <span className="ig-spin" aria-hidden="true" />;
  if (tone === "done") return <span className="ig-check" aria-hidden="true"><CheckIcon /></span>;
  return <span className={`ig-dot ${tone}`} aria-hidden="true" />;
}
