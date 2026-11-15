import { browser } from "wxt/browser";
import type { FromOverlay, ToBackground, ToContent } from "@/lib/messages";
import { getSettings, onSettings, setSettings, WIDTHS, type Corner, type Settings } from "@/lib/settings";
import { hasCaptionSource, startCaptionWatch } from "@/lib/captions";

// Content script: owns the signer iframe (position, size, drag-to-corner, fullscreen) and runs the caption watcher.
// The signer itself (video, captions, API calls) lives in overlay.html, an extension page.
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  async main() {
    const w = window as unknown as { __signlayer?: boolean };
    if (w.__signlayer) return; // injected twice (manifest + scripting fallback)
    w.__signlayer = true;

    let s: Settings = await getSettings();
    const MARGIN = 16;
    let host: HTMLElement | null = null;
    let frame: HTMLIFrameElement | null = null;
    let height = 380;
    let pos = { x: 0, y: 0 };
    let dragStart: { x: number; y: number } | null = null;
    let closedByUser = false;
    let shield: HTMLDivElement | null = null;
    let grab: { x: number; y: number } | null = null;
    const send = (msg: ToBackground) => browser.runtime.sendMessage(msg).catch(() => {});

    // ── Position, drag, snap ──
    function startDrag(g: { x: number; y: number } | null) {
      if (!frame || dragStart) return;
      dragStart = { ...pos };
      grab = g;
      frame.classList.add("dragging");
      if (shield && g) shield.hidden = false;
    }
    function moveTo(x: number, y: number) {
      if (frame) frame.style.transform = `translate(${x}px, ${y}px)`;
    }
    function endDrag() {
      if (!frame || !dragStart) return;
      const r = frame.getBoundingClientRect();
      dragStart = grab = null;
      if (shield) shield.hidden = true;
      frame.classList.remove("dragging");
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const corner = `${cy < innerHeight / 2 ? "t" : "b"}${cx < innerWidth / 2 ? "l" : "r"}` as Corner;
      s.corner = corner;
      place(corner);
      setSettings({ corner });
    }
    function place(corner: Corner = s.corner) {
      if (!frame) return;
      const fw = WIDTHS[s.size];
      const fs = document.fullscreenElement;
      const vw = fs ? innerWidth : document.documentElement.clientWidth || innerWidth;
      const vh = innerHeight;
      // Fullscreen video: stay clear of the player's control bar.
      const bottom = fs ? 76 : MARGIN;
      pos = { x: corner[1] === "l" ? MARGIN : vw - fw - MARGIN, y: corner[0] === "t" ? MARGIN : vh - height - bottom };
      pos.y = Math.max(MARGIN, pos.y);
      frame.style.width = `${fw}px`;
      frame.style.height = `${height}px`;
      frame.style.transformOrigin = `${corner[0] === "t" ? "top" : "bottom"} ${corner[1] === "l" ? "left" : "right"}`;
      frame.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    }

    // ── Mount / unmount (closed shadow root; the iframe carries the backdrop blur so the glass blurs the page) ──
    function mount() {
      if (host) return;
      host = document.createElement("signlayer-overlay");
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; }
        iframe { position: fixed; left: 0; top: 0; z-index: 2147483647; border: 0; margin: 0; padding: 0; display: block;
          color-scheme: light; background: transparent; border-radius: 26px; overflow: hidden;
          -webkit-backdrop-filter: blur(28px) saturate(180%) brightness(1.04); backdrop-filter: blur(28px) saturate(180%) brightness(1.04);
          box-shadow: 0 22px 48px -14px rgb(8 16 56 / .42), 0 2px 8px rgb(8 16 56 / .14);
          transition: transform .55s cubic-bezier(.2,.9,.25,1.05), width .4s cubic-bezier(.2,.8,.2,1), height .3s ease, opacity .35s ease, scale .35s cubic-bezier(.2,.9,.25,1.1);
          opacity: 1; scale: 1; }
        iframe.enter { opacity: 0; scale: .9; }
        iframe.dragging { transition: width .4s ease, height .3s ease, opacity .35s ease, scale .35s ease; }
        .shield { position: fixed; inset: 0; z-index: 2147483647; cursor: grabbing; background: transparent; }
        @media (prefers-reduced-motion: reduce) { iframe, iframe.dragging { transition: none; } }`;
      frame = document.createElement("iframe");
      frame.src = browser.runtime.getURL("/overlay.html");
      frame.title = "SIGNLAYER signer";
      frame.setAttribute("allowtransparency", "true");
      frame.setAttribute("allow", "autoplay");
      frame.classList.add("dragging", "enter");
      shield = document.createElement("div");
      shield.className = "shield";
      shield.hidden = true;
      // If the page (not the iframe) gets the pointer during a drag, the shield tracks it.
      shield.addEventListener("pointermove", (e) => {
        if (dragStart && grab) moveTo(e.clientX - grab.x, e.clientY - grab.y);
      });
      shield.addEventListener("pointerup", () => endDrag());
      root.append(style, frame, shield);
      (fullscreenHost() ?? document.documentElement).appendChild(host);
      place();
      setTimeout(() => frame?.classList.remove("dragging", "enter"), 60);
    }

    function unmount() {
      const f = frame, h = host;
      host = frame = shield = null;
      dragStart = grab = null;
      if (!f || !h) return;
      f.classList.add("enter");
      setTimeout(() => h.remove(), 360);
    }

    // ── Fullscreen: move the signer into the fullscreen element (moveBefore keeps the iframe alive) ──
    function fullscreenHost(): Element | null {
      const fs = document.fullscreenElement;
      return fs && !(fs instanceof HTMLVideoElement) && !(fs instanceof HTMLIFrameElement) ? fs : null;
    }
    document.addEventListener("fullscreenchange", () => {
      if (!host) return;
      const target = fullscreenHost() ?? document.documentElement;
      if (host.parentNode !== target) {
        const t = target as Element & { moveBefore?: (n: Node, ref: Node | null) => void };
        if (typeof t.moveBefore === "function") {
          try { t.moveBefore(host, null); } catch { target.appendChild(host); }
        } else target.appendChild(host);
      }
      requestAnimationFrame(() => place());
    });

    addEventListener("message", (e: MessageEvent) => {
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as FromOverlay;
      if (m?.sl !== 1) return;
      if (m.type === "height") {
        height = Math.ceil(m.h);
        place();
      } else if (m.type === "dragstart") startDrag({ x: m.x, y: m.y });
      else if (m.type === "drag") {
        startDrag(null);
        if (dragStart) moveTo(dragStart.x + m.dx, dragStart.y + m.dy);
      } else if (m.type === "dragend") endDrag();
      else if (m.type === "close") {
        closedByUser = true;
        unmount();
      }
    });
    addEventListener("resize", () => place());

    browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
      const m = raw as ToContent;
      if (m?.type === "mount") {
        closedByUser = false;
        mount();
      } else if (m?.type === "unmount") unmount();
      else if (m?.type === "toggle") {
        if (host) { closedByUser = true; unmount(); } else { closedByUser = false; mount(); }
      }
      sendResponse({ ok: true, mounted: !!host });
    });

    // ── Caption watcher (source: captions) ──
    let stopWatch: (() => void) | null = null;
    function syncWatcher() {
      const on = s.enabled && s.source === "captions";
      if (on && !stopWatch) {
        stopWatch = startCaptionWatch({
          phrase: (text, origin, next) => {
            if (closedByUser) return;
            if (!host) mount();
            send({ type: "sign", text, source: "captions", origin, next });
          },
          state: (state) => {
            if (state.kind !== "idle" && !host && !closedByUser) mount();
            send({ type: "source-state", state });
          },
          reset: () => send({ type: "reset" }),
        });
      } else if (!on && stopWatch) {
        stopWatch();
        stopWatch = null;
      }
    }

    onSettings((patch) => {
      s = { ...s, ...patch };
      if ("enabled" in patch) {
        if (!s.enabled) unmount();
        else if (s.source === "captions" && hasCaptionSource()) { closedByUser = false; mount(); }
      }
      if ("source" in patch && s.enabled && s.source === "captions" && hasCaptionSource() && !closedByUser) mount();
      if ("size" in patch || "corner" in patch) place();
      syncWatcher();
    });

    syncWatcher();
    const want = s.enabled && s.source === "captions" && hasCaptionSource();
    if (want) mount();
    send({ type: "hello", wantOverlay: want });
  },
});
