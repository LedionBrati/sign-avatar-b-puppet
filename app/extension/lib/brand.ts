import { MARK_SVG } from "@signlayer/core";

export const WORDMARK = `<span class="wm" role="img" aria-label="signlayer"><span aria-hidden="true">s<span class="wm-i">ı</span>gnlayer</span></span>`;
export const MARK = `<span class="mark" aria-hidden="true">${MARK_SVG}</span>`;
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
