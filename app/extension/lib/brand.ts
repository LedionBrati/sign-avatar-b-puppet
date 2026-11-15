// The SIGNLAYER mark, refined for the 2030 look: the same two tilted bars as core's MARK_SVG, on a
// continuous-corner (superellipse, n=5) cobalt tile with a soft top light, so it sits well next to system glyphs.
const SQUIRCLE =
  "M32 16L31.97 22.32L31.88 24.32L31.72 25.76L31.5 26.9L31.22 27.84L30.86 28.65L30.43 29.34L29.93 29.93L29.34 30.43L28.65 30.86L27.84 31.22L26.9 31.5L25.76 31.72L24.32 31.88L22.32 31.97L16 32L9.68 31.97L7.68 31.88L6.24 31.72L5.1 31.5L4.16 31.22L3.35 30.86L2.66 30.43L2.07 29.93L1.57 29.34L1.14 28.65L.78 27.84L.5 26.9L.28 25.76L.12 24.32L.03 22.32L0 16L.03 9.68L.12 7.68L.28 6.24L.5 5.1L.78 4.16L1.14 3.35L1.57 2.66L2.07 2.07L2.66 1.57L3.35 1.14L4.16 .78L5.1 .5L6.24 .28L7.68 .12L9.68 .03L16 0L22.32 .03L24.32 .12L25.76 .28L26.9 .5L27.84 .78L28.65 1.14L29.34 1.57L29.93 2.07L30.43 2.66L30.86 3.35L31.22 4.16L31.5 5.1L31.72 6.24L31.88 7.68L31.97 9.68Z";
let n = 0;
// Each copy gets its own gradient id: a copy inside a hidden section would otherwise take the gradient down with it.
const markSvg = (id = `sl-mark-${++n}`) =>
  `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a5bf0"/><stop offset="1" stop-color="#1a37c9"/></linearGradient></defs><path d="${SQUIRCLE}" fill="url(#${id})"/><g fill="#fff"><rect x="12.65" y="11.8" width="12.3" height="3" rx="1.5" transform="rotate(-6.5 18.8 13.3)"/><rect x="7" y="16.7" width="14.4" height="3" rx="1.5" transform="rotate(-6.5 14.2 18.2)"/></g></svg>`;

export const WORDMARK = `<span class="wm" role="img" aria-label="signlayer"><span aria-hidden="true">s<span class="wm-i">ı</span>gnlayer</span></span>`;
/** The mark, ready to drop into a page. Call it once per copy. */
export const mark = () => `<span class="mark" aria-hidden="true">${markSvg()}</span>`;
export const MARK = mark();
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// SF-Symbols-style line glyphs (24px grid, currentColor, round caps).
const svg = (d: string, extra = "") =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
export const ICON = {
  mic: svg(`<rect x="9" y="3.5" width="6" height="10.5" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V20.5M9.5 20.5h5"/>`),
  tab: svg(`<path d="M4.5 9.5h2.8L11.5 6v12l-4.2-3.5H4.5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.8 6.6a7.6 7.6 0 0 1 0 10.8"/>`),
  gear: svg(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`, ` stroke-width="1.5"`),
  close: svg(`<path d="M7 7l10 10M17 7L7 17"/>`),
  play: svg(`<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.7-6.2a.8.8 0 0 0 0-1.4L9.2 5.1A.8.8 0 0 0 8 5.8z" fill="currentColor" stroke="none"/>`),
  stop: svg(`<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none"/>`),
  offline: svg(`<path d="M3.5 3.5l17 17M8.6 15.6a4.8 4.8 0 0 1 6.2-.4M5.4 12.4a9.3 9.3 0 0 1 4-2.3M14.2 10a9.4 9.4 0 0 1 4.4 2.4M2.5 9.2a14 14 0 0 1 3.4-2.4M10 6.1a14 14 0 0 1 11.5 3.1M12 19h.01"/>`),
};
