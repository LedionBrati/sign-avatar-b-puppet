// Flux design tokens: the light look of the web app (app/web/src/styles.css `:root`, also mirrored in
// app/extension/lib/base.css), for the clients that can't read CSS (the phone app). A pastel paper field with soft
// colour blooms, white frosted-glass cards and pills with a bright rim, dark violet ink, a violet-blue accent,
// the lowercase "flux" wordmark and the transcript in a serif. The web and the extension style themselves in CSS;
// keep these values in step with styles.css when the look changes.

export const colors = {
  /** Page background and its top-to-bottom wash (--bg, the linear-gradient at the end of --bg-art). */
  bg: "#f6f6fb",
  bgWash: ["#f7f7fb", "#f4f3fb", "#eef0fd"],
  /** Ink: primary, secondary (>= 4.5:1), tertiary (placeholders, footnotes). */
  label: "#2b2660",
  label2: "rgba(43,38,96,0.78)",
  label3: "rgba(43,38,96,0.56)",
  hair: "rgba(43,38,96,0.1)",
  /** Quiet fills inside glass (rows, text buttons) and the frosted glass itself. */
  fill: "rgba(255,255,255,0.55)",
  fill2: "rgba(255,255,255,0.75)",
  glass: "rgba(255,255,255,0.72)",
  glassStrong: "rgba(255,255,255,0.86)",
  rim: "rgba(255,255,255,0.9)",
  /** Soft violet shadows under glass (--shadow-1/2), as "r,g,b". */
  shadow: "60,50,140",
  /** Accent: the primary button fill (a top-to-bottom gradient), its solid tone, a soft tint, the glow around it. */
  accent: "#4446d8",
  accentGrad: ["#5b5cf0", "#4446d8", "#3434b8"],
  accentSoft: "rgba(91,92,240,0.12)",
  glow: "rgba(120,110,255,0.35)",
  wordmarkDot: "#7b6cff",
  cyan: "#5ee7ff",
  /** The status island and the caption box. */
  island: "rgba(255,255,255,0.7)",
  capHeard: "rgba(43,38,96,0.7)",
  capBg: "rgba(255,255,255,0.55)",
  /** The signer clips' own studio backdrop (one flat tone between --stage-top #252a32 and --stage-bot #1b1f28):
   *  the stage behind the video, so the clip edge never shows a seam. */
  stage: "#20242d",
  /** Warnings on glass (safety card title). */
  warn: "#b4237a",
  white: "#ffffff",
} as const;

/** The soft colour blooms of the light background (--bg-art radial-gradients): "r,g,b", peak alpha, centre and radii
 *  in % of the screen. Each fades to nothing at 72 % of its radius. Peach, pink and violet pool along the bottom,
 *  cyan rises up the right edge, and a faint ice haze sits right of centre. */
export const blooms = [
  { c: "255,196,160", a: 0.85, x: 4, y: 104, rx: 42, ry: 46 },
  { c: "255,170,230", a: 0.9, x: 26, y: 100, rx: 48, ry: 52 },
  { c: "160,150,255", a: 0.85, x: 58, y: 102, rx: 46, ry: 50 },
  { c: "120,232,255", a: 0.9, x: 100, y: 78, rx: 44, ry: 58 },
  { c: "200,220,255", a: 0.45, x: 80, y: 40, rx: 60, ry: 40 },
] as const;

/** The listening wave's blues (web lib/signWave.ts, extension lib/wave.ts, phone SignWave). */
export const waveColors = ["31,63,214", "58,108,255", "96,165,255", "56,189,248", "120,140,255", "186,214,255"] as const;

/** Corner radii (--r-sm..--r-xl), the Live card (.fcard), the signer stage inside it, and capsules. */
export const radii = { sm: 14, md: 20, lg: 26, xl: 32, card: 30, stage: 24, pill: 999 } as const;

export const copy = {
  headline: "Hear anything.\nSee it signed.",
  sub: "Live sign language from real signers, with captions.",
  listen: "Tap to listen",
  any: "Works with announcements, appointments, news, lectures and conversations.",
  extTitle: "Browser extension",
  extSub: "A signer in the corner of any video, call or lecture.",
  credit: "AI avatar driven by real signers · WLASL / How2Sign, non-commercial research",
} as const;
