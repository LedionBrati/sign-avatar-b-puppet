import { browser } from "wxt/browser";

// The floating card's frame, injected into the page on a toolbar click (background.ts, chrome.scripting).
// Running it again on the same page closes the card (the toolbar icon toggles it).
//
//   <signlayer-float> (0×0, fixed)  └ closed shadow root
//      .card (fixed, draggable)  ├ .glass  frosted dark glass: backdrop blur of the page, cobalt tint, grain, sheen
//                                ├ iframe  overlay.html: the whole UI (an extension page, so the page's CSP never applies)
//                                └ .rim / .ring  light-catching edge; a slow cobalt ring of light while listening
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
.card { position: fixed; left: 0; top: 0; width: 300px; height: 540px; border-radius: 26px; pointer-events: auto; isolation: isolate;
  transform: translate3d(var(--x, 0px), var(--y, 0px), 0); opacity: 0; scale: .96; transform-origin: 50% 0;
  transition: opacity .32s cubic-bezier(.22,1,.36,1), scale .5s cubic-bezier(.2,.9,.25,1.05); }
.card.in { opacity: 1; scale: 1; }
.card.out { opacity: 0; scale: .96; transition-duration: .18s; }
.grip { position: absolute; z-index: 3; left: 0; top: 0; width: 0; height: 0; cursor: grab; touch-action: none; }
.card.dragging, .card.dragging .grip { cursor: grabbing; }
.card.dragging .glass { box-shadow: 0 40px 80px -24px rgb(4 10 50 / .7), 0 2px 10px rgb(4 10 50 / .25), 0 0 0 .5px rgb(255 255 255 / .12), 0 0 60px -10px rgb(58 108 255 / calc(var(--g, .25) + .15)); }
.glass { position: absolute; inset: 0; z-index: 0; border-radius: inherit; overflow: hidden;
  background:
    radial-gradient(120% 55% at 18% 0%, rgb(110 140 255 / .30), rgb(110 140 255 / 0) 62%),
    radial-gradient(90% 60% at 100% 100%, rgb(31 63 214 / .34), rgb(31 63 214 / 0) 70%),
    linear-gradient(170deg, rgb(26 36 112 / .80) 0%, rgb(12 18 62 / .84) 46%, rgb(7 10 34 / .90) 100%);
  -webkit-backdrop-filter: blur(30px) saturate(180%); backdrop-filter: blur(30px) saturate(180%);
  box-shadow: 0 30px 70px -26px rgb(4 10 50 / .7), 0 2px 10px rgb(4 10 50 / .22), 0 0 0 .5px rgb(255 255 255 / .1), 0 0 56px -12px rgb(58 108 255 / var(--g, .25));
  transition: box-shadow .6s ease; }
.glass::after { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .32; mix-blend-mode: soft-light; background-size: 220px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .9 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }
.sheen { position: absolute; top: -20%; bottom: -20%; width: 42%; left: -60%; transform: skewX(-18deg); pointer-events: none;
  background: linear-gradient(90deg, rgb(255 255 255 / 0), rgb(255 255 255 / .09) 50%, rgb(255 255 255 / 0)); animation: sheen 9s ease-in-out infinite; }
@keyframes sheen { 0%, 64% { left: -60%; } 100% { left: 140%; } }
iframe { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; border: 0; margin: 0; padding: 0; display: block; border-radius: inherit;
  background: transparent; color-scheme: light; }
.rim { position: absolute; inset: 0; z-index: 2; border-radius: inherit; pointer-events: none; padding: 1px;
  background: linear-gradient(135deg, rgb(255 255 255 / .75) 0%, rgb(255 255 255 / .18) 20%, rgb(255 255 255 / .04) 50%, rgb(160 185 255 / .2) 78%, rgb(190 210 255 / .62) 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
.ring { position: absolute; inset: 0; z-index: 2; border-radius: inherit; pointer-events: none; padding: 1.5px; overflow: hidden; opacity: 0; transition: opacity .6s ease;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
.ring i { position: absolute; left: 50%; top: 50%; width: 200%; aspect-ratio: 1; translate: -50% -50%;
  background: conic-gradient(from 0deg, rgb(58 108 255 / 0) 0deg, #3a6cff 50deg, #9fd0ff 92deg, rgb(58 108 255 / 0) 150deg, rgb(58 108 255 / 0) 200deg, #5b78ff 250deg, #b8c6ff 290deg, rgb(58 108 255 / 0) 340deg);
  animation: spin 5s linear infinite; }
@keyframes spin { to { rotate: 360deg; } }
.card[data-tone="live"] { --g: .42; } .card[data-tone="live"] .ring { opacity: .55; }
.card[data-tone="live"][data-voice="1"] { --g: .62; } .card[data-tone="live"][data-voice="1"] .ring { opacity: 1; }
.card[data-tone="sign"] { --g: .7; } .card[data-tone="sign"] .ring { opacity: 1; }
.card[data-tone="sign"] .ring i { animation-duration: 3s; }
@media (prefers-reduced-motion: reduce) { .sheen, .ring i { animation: none; } .card { transition: none; } }
`;

export default defineUnlistedScript(() => {
  const g = globalThis as { __slFloat?: { close(): void }; __slTabId?: number; __slAutostart?: string };
  if (g.__slFloat) { g.__slFloat.close(); return; }

  const extOrigin = new URL(browser.runtime.getURL("/")).origin;
  const host = document.createElement("signlayer-float");
  host.setAttribute("style", "all: initial !important; position: fixed !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important; pointer-events: none !important;");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${CSS}</style><div class="card" data-tone="idle"><div class="glass"><i class="sheen"></i></div><iframe title="SIGNLAYER signer" allow="autoplay" scrolling="no"></iframe><div class="rim"></div><div class="ring"><i></i></div><div class="grip" title="Drag to move"></div></div>`;
  const card = root.querySelector<HTMLElement>(".card")!;
  const frame = root.querySelector<HTMLIFrameElement>("iframe")!;
  const grip = root.querySelector<HTMLElement>(".grip")!;
  const q = new URLSearchParams({ tab: String(g.__slTabId ?? "") });
  if (g.__slAutostart) q.set("autostart", g.__slAutostart);
  frame.src = browser.runtime.getURL(`/overlay.html?${q}`);

  let w = 300, h = 540, x = 0, y = 0, placed = false, saved: Pos | null = null;
  const vw = () => document.documentElement.clientWidth || innerWidth;
  const vh = () => innerHeight;
  const M = 8;
  const clamp = () => {
    x = Math.round(Math.min(Math.max(M, x), Math.max(M, vw() - w - M)));
    y = Math.round(Math.min(Math.max(M, y), Math.max(M, vh() - h - M)));
  };
  const apply = () => { card.style.setProperty("--x", `${x}px`); card.style.setProperty("--y", `${y}px`); };
  const place = () => {
    if (saved) { x = saved.ax === "r" ? vw() - w - saved.dx : saved.dx; y = saved.y; }
    else { x = vw() - w - 20; y = 20; }
    clamp(); apply();
  };
  const save = () => {
    const ax = x + w / 2 > vw() / 2 ? "r" : "l";
    saved = { ax, dx: ax === "r" ? vw() - w - x : x, y };
    browser.storage.local.set({ floatPos: saved }).catch(() => {});
  };
  const post = (m: object) => frame.contentWindow?.postMessage({ sl: 1, ...m }, extOrigin);
  const sendViewport = () => post({ type: "viewport", w: vw(), h: vh() });

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

  function close() {
    if (!g.__slFloat) return;
    g.__slFloat = undefined;
    removeEventListener("message", onMessage);
    removeEventListener("resize", onResize);
    post({ type: "closing" });
    card.classList.remove("in");
    card.classList.add("out");
    setTimeout(() => host.remove(), 200); // the iframe unloads with it: its port drops and the capture stops
  }
  g.__slFloat = { close };
  addEventListener("message", onMessage);
  addEventListener("resize", onResize);

  browser.storage.local.get("floatPos").then((r) => {
    const p = r.floatPos as Pos | undefined;
    if (p && (p.ax === "l" || p.ax === "r") && Number.isFinite(p.dx) && Number.isFinite(p.y)) saved = p;
    if (placed) place();
  }).catch(() => {});
  document.documentElement.append(host);
});
