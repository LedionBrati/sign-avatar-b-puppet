import { browser } from "wxt/browser";

// The floating card's frame, injected into the page on a toolbar click (background.ts, chrome.scripting).
// Running it again on the same page closes the card (the toolbar icon toggles it).
//
//   <signlayer-float> (0×0, fixed)  └ closed shadow root
//      .card (fixed, draggable)  ├ .glass  frosted white glass: backdrop blur of the page, pastel wash, sheen
//                                ├ iframe  overlay.html: the whole UI (an extension page, so the page's CSP never applies)
//                                └ .rim / .ring  bright white rim; a slow pastel ring of light while listening
//
// The iframe posts layout (its size), where its header grip is (we lay a transparent drag handle over it, so the
// drag runs in page coordinates), its state (for the glow) and close. Position
// and size are remembered in chrome.storage.local; the card stays inside the viewport. Only the card takes clicks.

type FromCard =
  | { sl: 1; type: "layout"; w: number; h: number }
  | { sl: 1; type: "grip"; x: number; y: number; w: number; h: number }
  | { sl: 1; type: "state"; tone: string; voice: boolean }
  | { sl: 1; type: "close" };
type Pos = { ax: "l" | "r"; dx: number; y: number };

const CSS = `
:host { all: initial; }
.card { position: fixed; left: 0; top: 0; width: 300px; height: 540px; border-radius: 28px; pointer-events: auto; isolation: isolate;
  transform: translate3d(var(--x, 0px), var(--y, 0px), 0); opacity: 0; scale: .96; transform-origin: 50% 0;
  transition: opacity .32s cubic-bezier(.22,1,.36,1), scale .5s cubic-bezier(.2,.9,.25,1.05); }
.card.in { opacity: 1; scale: 1; }
.card.out { opacity: 0; scale: .96; transition-duration: .18s; }
.grip { position: absolute; z-index: 3; left: 0; top: 0; width: 0; height: 0; cursor: grab; touch-action: none; }
.card.dragging, .card.dragging .grip { cursor: grabbing; }
/* Light frosted white glass (the web app's Live card). Enough white and a lavender shadow that it never melts into a
   white page; a faint pastel wash at the foot so on a dark page it reads as frosted light, not grey. */
.glass { position: absolute; inset: 0; z-index: 0; border-radius: inherit; overflow: hidden;
  background:
    radial-gradient(70% 34% at 12% 104%, rgb(255 170 230 / .26), rgb(255 170 230 / 0) 72%),
    radial-gradient(70% 36% at 92% 100%, rgb(120 232 255 / .24), rgb(120 232 255 / 0) 72%),
    radial-gradient(90% 40% at 50% 112%, rgb(160 150 255 / .2), rgb(160 150 255 / 0) 72%),
    linear-gradient(160deg, rgb(255 255 255 / .76) 0%, rgb(252 251 255 / .66) 50%, rgb(255 255 255 / .72) 100%);
  -webkit-backdrop-filter: blur(22px) saturate(160%); backdrop-filter: blur(22px) saturate(160%);
  box-shadow: 0 30px 70px -26px rgb(60 50 140 / .42), 0 6px 18px -6px rgb(60 50 140 / .16), 0 0 0 .5px rgb(60 50 140 / .14), 0 0 60px -14px rgb(160 150 255 / var(--g, 0));
  transition: box-shadow .6s ease; }
.card.dragging .glass { box-shadow: 0 40px 84px -26px rgb(60 50 140 / .5), 0 8px 22px -6px rgb(60 50 140 / .2), 0 0 0 .5px rgb(60 50 140 / .16), 0 0 60px -12px rgb(160 150 255 / calc(var(--g, 0) + .2)); }
.glass::after { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .14; mix-blend-mode: soft-light; background-size: 220px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .9 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }
.sheen { position: absolute; top: -20%; bottom: -20%; width: 34%; left: -60%; transform: skewX(-18deg); pointer-events: none;
  background: linear-gradient(90deg, rgb(255 255 255 / 0), rgb(255 255 255 / .32) 50%, rgb(255 255 255 / 0)); animation: sheen 10s ease-in-out infinite; }
@keyframes sheen { 0%, 64% { left: -60%; } 100% { left: 140%; } }
iframe { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; border: 0; margin: 0; padding: 0; display: block; border-radius: inherit;
  background: transparent; color-scheme: light; }
/* Bright white 1px rim, strongest top-left. */
.rim { position: absolute; inset: 0; z-index: 2; border-radius: inherit; pointer-events: none; padding: 1px;
  background: linear-gradient(135deg, rgb(255 255 255 / 1) 0%, rgb(255 255 255 / .7) 35%, rgb(255 255 255 / .45) 60%, rgb(255 255 255 / .95) 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
/* Listening: a slow pastel ring of light runs round the edge (the web orb's ring). */
.ring { position: absolute; inset: 0; z-index: 2; border-radius: inherit; pointer-events: none; padding: 1.5px; overflow: hidden; opacity: 0; transition: opacity .6s ease;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
.ring i { position: absolute; left: 50%; top: 50%; width: 200%; aspect-ratio: 1; translate: -50% -50%;
  background: conic-gradient(from 0deg, rgb(255 170 230 / 0), rgb(255 170 230 / .95) 16%, rgb(160 150 255 / .7) 38%, rgb(120 232 255 / 0) 52%, rgb(120 232 255 / .9) 76%, rgb(255 170 230 / 0));
  animation: spin 6s linear infinite; }
@keyframes spin { to { rotate: 360deg; } }
.card[data-tone="live"] { --g: .35; } .card[data-tone="live"] .ring { opacity: .6; }
.card[data-tone="live"][data-voice="1"] { --g: .55; } .card[data-tone="live"][data-voice="1"] .ring { opacity: 1; }
.card[data-tone="sign"] { --g: .6; } .card[data-tone="sign"] .ring { opacity: 1; }
.card[data-tone="sign"] .ring i { animation-duration: 3.5s; }
@media (prefers-reduced-motion: reduce) { .sheen, .ring i { animation: none; } .card { transition: none; } }
`;

export default defineUnlistedScript(() => {
  const g = globalThis as { __slFloat?: { close(): void }; __slTabId?: number; __slAutostart?: string };
  if (g.__slFloat) { g.__slFloat.close(); return; }

  const extOrigin = new URL(browser.runtime.getURL("/")).origin;
  // DOM APIs only, no innerHTML: YouTube, Meet and other Google pages enforce Trusted Types
  // (require-trusted-types-for 'script'), and a string HTML sink would throw there. Styles go through the CSSOM
  // (host.style, adoptedStyleSheets), which the page's CSP style-src doesn't govern.
  const host = document.createElement("signlayer-float");
  const HOST_STYLE: [string, string][] = [["all", "initial"], ["position", "fixed"], ["left", "0"], ["top", "0"], ["right", "auto"], ["bottom", "auto"],
    ["width", "0"], ["height", "0"], ["margin", "0"], ["padding", "0"], ["border", "0"], ["background", "transparent"], ["overflow", "visible"],
    ["z-index", "2147483647"], ["display", "block"], ["pointer-events", "none"]];
  for (const [k, v] of HOST_STYLE) host.style.setProperty(k, v, "important");
  const root = host.attachShadow({ mode: "closed" });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const st = document.createElement("style");
    st.textContent = CSS;
    root.append(st);
  }
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: Node) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    parent?.appendChild(e);
    return e;
  };
  const card = el("div", "card", root);
  card.dataset.tone = "idle";
  el("i", "sheen", el("div", "glass", card));
  const frame = el("iframe", "", card);
  frame.title = "Flux signer";
  frame.setAttribute("allow", "autoplay");
  frame.setAttribute("scrolling", "no");
  el("div", "rim", card);
  el("i", "", el("div", "ring", card));
  const grip = el("div", "grip", card);
  grip.title = "Drag to move";
  const q = new URLSearchParams({ tab: String(g.__slTabId ?? "") });
  if (g.__slAutostart) q.set("autostart", g.__slAutostart);
  frame.src = browser.runtime.getURL(`/overlay.html?${q}`);

  let w = 300, h = 540, x = 0, y = 0, placed = false, saved: Pos | null = null;
  const vw = () => document.documentElement.clientWidth || innerWidth;
  // Video calls (Meet, Zoom web): the card never covers the bottom control bar, and starts top-left
  // (their chat / people panels open on the right). It can still be dragged anywhere above the bar.
  const CALL = /(^|\.)meet\.google\.com$|(^|\.)zoom\.(us|com)$|(^|\.)teams\.(microsoft|live)\.com$/.test(location.hostname);
  const BAR = CALL ? 96 : 0;
  const vh = () => innerHeight;
  const room = () => (document.fullscreenElement ? vh() : vh() - BAR);
  const M = 8;
  const clamp = () => {
    x = Math.round(Math.min(Math.max(M, x), Math.max(M, vw() - w - M)));
    y = Math.round(Math.min(Math.max(M, y), Math.max(M, room() - h - M)));
  };
  const apply = () => { card.style.setProperty("--x", `${x}px`); card.style.setProperty("--y", `${y}px`); };
  const place = () => {
    if (saved) { x = saved.ax === "r" ? vw() - w - saved.dx : saved.dx; y = saved.y; }
    else { x = CALL ? 20 : vw() - w - 20; y = CALL ? 72 : 20; }
    clamp(); apply();
  };
  const save = () => {
    const ax = x + w / 2 > vw() / 2 ? "r" : "l";
    saved = { ax, dx: ax === "r" ? vw() - w - x : x, y };
    browser.storage.local.set({ floatPos: saved }).catch(() => {});
  };
  const post = (m: object) => frame.contentWindow?.postMessage({ sl: 1, ...m }, extOrigin);
  const sendViewport = () => post({ type: "viewport", w: vw(), h: room() });

  // Drag: in page coordinates, on the grip over the card's header.
  let drag: { dx: number; dy: number } | null = null, raf = 0;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    drag = { dx: e.clientX - x, dy: e.clientY - y };
    card.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag) return;
    x = e.clientX - drag.dx; y = e.clientY - drag.dy; clamp();
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; apply(); });
  });
  const endDrag = () => { if (!drag) return; drag = null; card.classList.remove("dragging"); apply(); save(); };
  grip.addEventListener("pointerup", endDrag);
  grip.addEventListener("pointercancel", endDrag);
  grip.addEventListener("lostpointercapture", endDrag);

  function onMessage(e: MessageEvent) {
    if (e.source !== frame.contentWindow || e.origin !== extOrigin) return;
    const m = e.data as FromCard;
    if (m?.sl !== 1) return;
    if (m.type === "layout") {
      w = Math.ceil(m.w); h = Math.ceil(m.h);
      card.style.width = `${w}px`; card.style.height = `${h}px`;
      if (!placed) { placed = true; place(); sendViewport(); requestAnimationFrame(() => card.classList.add("in")); }
      else { clamp(); apply(); }
    } else if (m.type === "grip") {
      Object.assign(grip.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${Math.max(0, m.w)}px`, height: `${m.h}px` });
    } else if (m.type === "state") {
      card.dataset.tone = m.tone;
      card.dataset.voice = m.voice ? "1" : "0";
    } else if (m.type === "close") close();
  }
  const onResize = () => { if (!placed) return; if (saved) place(); else { clamp(); apply(); } sendViewport(); };

  // Fullscreen (YouTube's player, a call's stage): only the top layer is painted, so the card would vanish. Show the
  // host as a manual popover then: it joins the top layer above the fullscreen element without moving in the DOM
  // (moving it would reload the iframe and stop listening). On exit it goes back to a plain fixed element (its
  // inline display:block !important keeps it shown when the popover is closed), so it is always there afterwards.
  const topLayer = (on: boolean) => {
    try {
      if (on) {
        if (!host.hasAttribute("popover")) host.setAttribute("popover", "manual");
        if (host.matches(":popover-open")) host.hidePopover(); // re-show: above the element that just went fullscreen
        host.showPopover();
      } else if (host.hasAttribute("popover")) {
        if (host.matches(":popover-open")) host.hidePopover();
        host.removeAttribute("popover");
      }
    } catch { /* no popover API: the card simply waits under the fullscreen element and is back on exit */ }
  };
  const onFullscreen = () => {
    topLayer(!!document.fullscreenElement && document.fullscreenElement !== host);
    requestAnimationFrame(onResize);
  };

  function close() {
    if (!g.__slFloat) return;
    g.__slFloat = undefined;
    removeEventListener("message", onMessage);
    removeEventListener("resize", onResize);
    document.removeEventListener("fullscreenchange", onFullscreen);
    post({ type: "closing" });
    card.classList.remove("in");
    card.classList.add("out");
    setTimeout(() => host.remove(), 200); // the iframe unloads with it: its port drops and the capture stops
  }
  g.__slFloat = { close };
  addEventListener("message", onMessage);
  addEventListener("resize", onResize);
  document.addEventListener("fullscreenchange", onFullscreen);

  browser.storage.local.get("floatPos").then((r) => {
    const p = r.floatPos as Pos | undefined;
    if (p && (p.ax === "l" || p.ax === "r") && Number.isFinite(p.dx) && Number.isFinite(p.y)) saved = p;
    if (placed) place();
  }).catch(() => {});
  document.documentElement.append(host);
  if (document.fullscreenElement) onFullscreen();
});
