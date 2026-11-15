// The SIGNLAYER mark (same geometry as MARK_SVG in @signlayer/core) with themeable colours:
// tile = currentColor, bars = --mark-bars. White tile + cobalt bars on blue.
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
    <span className="wm light" role="img" aria-label="signlayer">
      <span aria-hidden="true">s<span className="wm-i">ı</span>gnlayer</span>
    </span>
  );
}

export const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </svg>
);

export const GearIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

export const ExtIcon = () => (
  <svg viewBox="0 0 40 30" width="40" height="30" aria-hidden="true">
    <rect x="1" y="1" width="38" height="28" rx="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M1 8h38" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="6" cy="4.6" r="1.1" fill="currentColor" /><circle cx="10" cy="4.6" r="1.1" fill="currentColor" />
    <rect x="6" y="13" width="15" height="2.2" rx="1.1" fill="currentColor" opacity=".55" />
    <rect x="6" y="18" width="10" height="2.2" rx="1.1" fill="currentColor" opacity=".55" />
    <circle cx="30" cy="20" r="6" fill="currentColor" /><circle cx="30" cy="18.6" r="1.8" fill="#1f3fd6" />
    <path d="M26.6 24c.7-1.8 2-2.6 3.4-2.6s2.7.8 3.4 2.6" fill="#1f3fd6" />
  </svg>
);
