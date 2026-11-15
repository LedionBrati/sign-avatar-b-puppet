// SIGNLAYER design tokens, from the team's prototype (claude.ai artifacts "SIGNLAYER App" and the
// concept page). Grainy cobalt-to-paper gradients, frosted glass pills/cards, lowercase "sıgnlayer"
// wordmark (Inter 500, the dotless ı carries a cobalt dot), system/Helvetica type.

export const colors = {
  table: "#cbcbcc",
  paper: "#eeeff1",
  paper2: "#f5f5f6",
  mist: "#c5cdec",
  cobalt: "#1f3fd6",
  cobaltDeep: "#0c228f",
  cobaltMid: "#2b4be0",
  inkBlue: "#1f34b5",
  ink: "#15193a",
  white: "#ffffff",
  glass: "rgba(255,255,255,0.13)",
  glassEdge: "rgba(255,255,255,0.62)",
  glassHi: "rgba(255,255,255,0.55)",
  island: "rgba(6,12,52,0.62)",
  wordmarkDotOnBlue: "#7d97ff",
} as const;

/** One colour per speaker lane: chip colour + card glow. */
export const speakers = [
  { spk: "#2f55ff", glow: "#a9bbff" },
  { spk: "#1f8fff", glow: "#9fd6ff" },
  { spk: "#5a46f0", glow: "#c2b8ff" },
] as const;

/** Live screen background (".g.live" in the prototype), top to bottom. */
export const liveGradient = ["#1530c4", "#1f3fd6", "#3352e4", "#8fa2ee"] as const;

/** The listening wave's blues (SignWave). */
export const waveColors = ["31,63,214", "58,108,255", "96,165,255", "56,189,248", "120,140,255", "186,214,255"] as const;

export const radii = { card: 32, caption: 24, pill: 999, device: 36 } as const;

export const copy = {
  headline: "Hear anything.\nSee it signed.",
  sub: "Live sign language from real signers, with captions.",
  listen: "Tap to listen",
  any: "Works with announcements, appointments, news, lectures and conversations.",
  extTitle: "Browser extension",
  extSub: "A signer in the corner of any video, call or lecture.",
  credit: "AI avatar driven by real signers · WLASL / How2Sign, non-commercial research",
} as const;

/** The SIGNLAYER mark (32x32): cobalt tile + two white tilted bars. */
export const MARK_SVG = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="7.4" fill="#1f3fd6"/><g fill="#fff"><rect x="12.65" y="11.8" width="12.3" height="3" rx="1.5" transform="rotate(-6.5 18.8 13.3)"/><rect x="7" y="16.7" width="14.4" height="3" rx="1.5" transform="rotate(-6.5 14.2 18.2)"/></g></svg>`;
