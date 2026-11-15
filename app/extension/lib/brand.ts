// The Flux mark (app/web/src/components/Icons.tsx): a pastel gradient tile with a white serif italic "f", centred.
let n = 0;
// Each copy gets its own gradient id: a copy inside a hidden section would otherwise take the gradient down with it.
const markSvg = (id = `flux-mark-${++n}`) =>
  `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9ad5"/><stop offset=".5" stop-color="#8b7cff"/><stop offset="1" stop-color="#5ee7ff"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#${id})"/><text x="15.4" y="16.6" text-anchor="middle" dominant-baseline="central" fill="#fff" style="font: italic 500 22px 'Newsreader Variable', Newsreader, Georgia, serif">f</text></svg>`;

/** "flux" in Newsreader italic (styled by .wm in base.css). */
export const WORDMARK = `<span class="wm" role="img" aria-label="Flux"><span aria-hidden="true">flux</span></span>`;
/** The mark, ready to drop into a page. Call it once per copy. */
export const mark = () => `<span class="mark" aria-hidden="true">${markSvg()}</span>`;
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
