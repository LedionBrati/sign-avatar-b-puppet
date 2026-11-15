// Small line icons (24px grid, currentColor), shared by the signer and the popup.
import type { Source } from "./settings";

const svg = (d: string, extra = "") =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;

export const ICON = {
  captions: svg(`<rect x="3" y="5" width="18" height="14" rx="3.5"/><path d="M10.5 10.2a2.3 2.3 0 1 0 0 3.6M17 10.2a2.3 2.3 0 1 0 0 3.6"/>`),
  tab: svg(`<path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.3 6.5a7.5 7.5 0 0 1 0 11"/>`),
  mic: svg(`<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/>`),
  selection: svg(`<path d="M5 6h14M5 12h9M5 18h6"/><path d="M17 14v7M15 14h4M15 21h4"/>`),
  close: svg(`<path d="M7 7l10 10M17 7 7 17"/>`, ` stroke-width="2.2"`),
  check: svg(`<path d="m5 12.5 4.5 4.5L19 7.5"/>`, ` stroke-width="2.2"`),
  play: svg(`<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>`),
  info: svg(`<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>`),
  offline: svg(`<path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14.5 10.5A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4-2.4M12 20h.01"/>`),
  grip: svg(`<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>`, ` stroke-width="3"`),
  question: svg(`<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.7M12 17h.01"/>`),
  pause: svg(`<path d="M9 6v12M15 6v12"/>`, ` stroke-width="2.4"`),
};

export const SOURCE_ICON: Record<Source, string> = { captions: ICON.captions, tab: ICON.tab, mic: ICON.mic, selection: ICON.selection };
