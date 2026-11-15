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
