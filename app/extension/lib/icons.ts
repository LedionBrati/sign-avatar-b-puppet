// SF-Symbols-style line glyphs (24px grid, currentColor, 1.75 stroke, round caps), shared by the signer and the popup.
import type { Source } from "./settings";

const svg = (d: string, extra = "") =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;

export const ICON = {
  /** captions.bubble */
  captions: svg(`<path d="M6.5 4.5h11a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3h-5.2L8 20.2v-3.2H6.5a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3z"/><path d="M7.5 9.5h4M13.8 9.5h2.7M7.5 13h2.2M12 13h4.5"/>`),
  /** text.below.photo: captions under the signer */
  subtitles: svg(`<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><path d="M7.5 15.5h5M14.8 15.5h1.7M7.5 12h9"/>`),
  /** speaker.wave.2 */
  tab: svg(`<path d="M4.5 9.5h2.8L11.5 6v12l-4.2-3.5H4.5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.8 6.6a7.6 7.6 0 0 1 0 10.8"/>`),
  /** mic */
  mic: svg(`<rect x="9" y="3.5" width="6" height="10.5" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V20.5M9.5 20.5h5"/>`),
  /** text.cursor */
  selection: svg(`<path d="M4 7h9M4 12h6M4 17h7"/><path d="M17.5 5v14M15.5 5h4M15.5 19h4"/>`),
  /** arrow.up.left.and.arrow.down.right */
  size: svg(`<path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5 13.5 10.5M4.5 19.5l6-6"/>`),
  /** xmark */
  close: svg(`<path d="M7 7l10 10M17 7 7 17"/>`, ` stroke-width="2"`),
  check: svg(`<path d="m5.5 12.5 4 4L18.5 7.5"/>`, ` stroke-width="2"`),
  play: svg(`<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.7-6.2a.8.8 0 0 0 0-1.4L9.2 5.1A.8.8 0 0 0 8 5.8z" fill="currentColor" stroke="none"/>`),
  info: svg(`<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>`),
  /** wifi.slash */
  offline: svg(`<path d="M3.5 3.5l17 17M8.6 15.6a4.8 4.8 0 0 1 6.2-.4M5.4 12.4a9.3 9.3 0 0 1 4-2.3M14.2 10a9.4 9.4 0 0 1 4.4 2.4M2.5 9.2a14 14 0 0 1 3.4-2.4M10 6.1a14 14 0 0 1 11.5 3.1M12 19h.01"/>`),
  question: svg(`<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.5a2.4 2.4 0 0 1 4.6.9c0 1.6-2.3 2-2.3 3.6M12 16.8h.01"/>`),
  pause: svg(`<path d="M9 6.5v11M15 6.5v11"/>`, ` stroke-width="2.4"`),
  /** hand.raised: a sign */
  hand: svg(`<path d="M8.5 12V6.2a1.3 1.3 0 0 1 2.6 0V11M11.1 10.5V4.8a1.3 1.3 0 0 1 2.6 0v5.7M13.7 10.5V6a1.3 1.3 0 0 1 2.6 0v6.5M16.3 9.5a1.3 1.3 0 0 1 2.6 0V14a6.5 6.5 0 0 1-6.5 6.5h-.6a6 6 0 0 1-4.6-2.2l-2.6-3.2a1.4 1.4 0 0 1 2.1-1.8l1.8 1.7V12"/>`),
  chevron: svg(`<path d="m9 6 6 6-6 6"/>`, ` stroke-width="2"`),
};

export const SOURCE_ICON: Record<Source, string> = { captions: ICON.captions, tab: ICON.tab, mic: ICON.mic, selection: ICON.selection };
