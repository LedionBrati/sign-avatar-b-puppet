// The SIGNLAYER mark (same geometry as MARK_SVG in @signlayer/core): cobalt tile, white bars.
// Glyphs are drawn on a 24-pt grid with a 1.7 stroke, SF Symbols style.
import type { ReactNode } from "react";

export function Mark({ className = "mark" }: { className?: string }) {
  return (
    <span className={className}>
      <svg viewBox="0 0 32 32" role="img" aria-label="SIGNLAYER">
        <rect width="32" height="32" rx="7.4" fill="currentColor" />
        <g style={{ fill: "var(--mark-bars, #fff)" }}>
          <rect x="12.65" y="11.8" width="12.3" height="3" rx="1.5" transform="rotate(-6.5 18.8 13.3)" />
          <rect x="7" y="16.7" width="14.4" height="3" rx="1.5" transform="rotate(-6.5 14.2 18.2)" />
        </g>
      </svg>
    </span>
  );
}

export function Wordmark() {
  return (
    <span className="wm" role="img" aria-label="signlayer">
      <span aria-hidden="true">s<span className="wm-i">ı</span>gnlayer</span>
    </span>
  );
}

const G = ({ children, w = 1.7 }: { children: ReactNode; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

export const MicIcon = () => <G><rect x="9" y="3" width="6" height="11.5" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></G>;
export const CloseIcon = () => <G w={2}><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></G>;
export const StopIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2.6" fill="currentColor" /></svg>;
export const KeyboardIcon = () => <G><rect x="2.8" y="6" width="18.4" height="12" rx="3" /><path d="M6.5 9.6h.01M10 9.6h.01M13.5 9.6h.01M17 9.6h.01M7.5 14.4h9" /></G>;
export const ReplayIcon = () => <G><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.2 3.8v4h4" /></G>;
export const CheckIcon = () => <G w={2.2}><path d="M5.5 12.5l4.2 4.2 8.8-9.4" /></G>;
export const ArrowUpIcon = () => <G w={2.2}><path d="M12 19V5.5M6 11.5l6-6 6 6" /></G>;
export const SpeakerIcon = () => <G><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" /><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.6 7.6 0 0 1 0 11" /></G>;
export const GridIcon = () => <G><rect x="4" y="4" width="6.5" height="6.5" rx="1.8" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" /></G>;
export const ClockIcon = () => <G><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></G>;
export const UndoIcon = () => <G><path d="M9 14.5L4.5 10 9 5.5" /><path d="M4.5 10h10a5 5 0 0 1 0 10H12" /></G>;
export const CaptionsIcon = ({ off }: { off?: boolean }) => (
  <G>
    <rect x="3" y="5.5" width="18" height="13" rx="3.5" />
    <path d="M10.2 10.4a2.2 2.2 0 1 0 0 3.2M16.2 10.4a2.2 2.2 0 1 0 0 3.2" />
    {off ? <path d="M4 4l16 16" /> : null}
  </G>
);
export const GearIcon = () => (
  <G w={1.6}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </G>
);
export const HandIcon = () => (
  <G>
    <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5V4a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a6.5 6.5 0 0 1-5.2-2.6L3.6 16a1.6 1.6 0 0 1 2.5-2l1.9 2" />
  </G>
);
