import { browser } from "wxt/browser";
import type { FromOverlay, ToBackground, ToContent, ToFrame } from "@/lib/messages";
import { getSettings, onSettings, setSettings, WIDTHS, type Corner, type Settings, type Size } from "@/lib/settings";
import { hasCaptionSource, startCaptionWatch } from "@/lib/captions";

// Content script: owns the signer iframe (position, size, drag with momentum + magnetic corners, fullscreen, the page's
// light/dark look) and runs the caption watcher. The signer itself (video, captions, API calls) lives in overlay.html.
const SPRING = "linear(0, 0.016, 0.057, 0.113, 0.178, 0.247, 0.317, 0.385, 0.451, 0.512, 0.568, 0.62, 0.667, 0.709, 0.746, 0.78, 0.809, 0.835, 0.858, 0.877, 0.895, 0.909, 0.922, 0.934, 0.943, 0.952, 0.959, 0.965, 0.97, 0.975, 0.978, 0.982, 0.984, 0.987, 0.989, 0.991, 0.992, 0.993, 0.994, 0.995, 0.996, 0.997, 0.998, 0.999, 1)";
const SPRING_BOUNCE = "linear(0, 0.021, 0.076, 0.153, 0.245, 0.343, 0.442, 0.538, 0.627, 0.709, 0.781, 0.844, 0.896, 0.939, 0.974, 1.001, 1.02, 1.034, 1.043, 1.048, 1.05, 1.049, 1.047, 1.043, 1.039, 1.034, 1.029, 1.024, 1.019, 1.015, 1.012, 1.008, 1.006, 1.003, 1.002, 1, 0.999, 0.998, 0.999, 1)";

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
    // Card geometry per size (overlay/style.css): corner radius, padding, caption sheet height.
    const RADIUS: Record<Size, number> = { s: 26, m: 30, l: 34 };
    const PAD: Record<Size, number> = { s: 5, m: 6, l: 7 };
    const SHEET: Record<Size, number> = { s: 13 * 1.32 * 2 + 16, m: 15 * 1.32 * 2 + 20, l: 17 * 1.32 * 2 + 24 };
    const predictHeight = () => {
      const w = WIDTHS[s.size], p = PAD[s.size];
      return Math.ceil(2 * p + ((w - 2 * p) * 4) / 3 + (s.captions ? SHEET[s.size] : 0));
    };
    let sizeAnimUntil = 0; // while the size springs, the iframe follows the predicted height, not every reflow
    let samples: { t: number; x: number; y: number }[] = [];

    function startDrag(g: { x: number; y: number } | null) {
      if (!frame || dragStart) return;
      dragStart = { ...pos };
      grab = g;
      samples = [];
      frame.classList.add("dragging");
      if (shield && g) shield.hidden = false;
    }
    function moveTo(x: number, y: number) {
      if (!frame) return;
      frame.style.transform = `translate(${x}px, ${y}px)`;
      const t = performance.now();
      samples.push({ t, x, y });
      while (samples.length > 2 && t - samples[0]!.t > 90) samples.shift();
    }
    function endDrag() {
      if (!frame || !dragStart) return;
      const r = frame.getBoundingClientRect();
      dragStart = grab = null;
      if (shield) shield.hidden = true;
      frame.classList.remove("dragging");
      // Momentum: project where a flick would carry the card, then let the nearest corner pull it in.
      let vx = 0, vy = 0;
      const a = samples[0], b = samples.at(-1);
      if (a && b && b.t - a.t > 8 && performance.now() - b.t < 120) { vx = (b.x - a.x) / (b.t - a.t); vy = (b.y - a.y) / (b.t - a.t); }
      const THROW_MS = 260;
      const cx = r.left + r.width / 2 + vx * THROW_MS, cy = r.top + r.height / 2 + vy * THROW_MS;
      const corner = `${cy < innerHeight / 2 ? "t" : "b"}${cx < innerWidth / 2 ? "l" : "r"}` as Corner;
      s.corner = corner;
      place(corner);
      setSettings({ corner });
    }
    /** Room to leave at the bottom: YouTube fullscreen keeps clear of the control bar while it shows. */
    function bottomInset() {
      const fs = document.fullscreenElement;
      if (!fs) return MARGIN;
      const yt = fs.closest?.(".html5-video-player") ?? fs.querySelector?.(".html5-video-player");
      if (yt) return yt.classList.contains("ytp-autohide") ? 24 : 84;
      return 76;
    }
    function place(corner: Corner = s.corner) {
      if (!frame) return;
      const fw = WIDTHS[s.size];
      const fs = document.fullscreenElement;
      const vw = fs ? innerWidth : document.documentElement.clientWidth || innerWidth;
      const vh = innerHeight;
      const m = fs ? 24 : MARGIN;
      pos = { x: corner[1] === "l" ? m : vw - fw - m, y: corner[0] === "t" ? m : vh - height - bottomInset() };
      pos.y = Math.max(m, pos.y);
      frame.style.width = `${fw}px`;
      frame.style.height = `${height}px`;
      frame.style.borderRadius = `${RADIUS[s.size]}px`;
      frame.style.transformOrigin = `${corner[0] === "t" ? "top" : "bottom"} ${corner[1] === "l" ? "left" : "right"}`;
      frame.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    }

    // ── The page's look: light or dark glass (YouTube's dark theme, any dark site, fullscreen video) ──
    const parseRgb = (c: string) => {
      const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+%?))?/.exec(c);
      if (!m) return null;
      const al = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: al };
    };
    function pageIsDark() {
      if (document.fullscreenElement) return true;
      const html = document.documentElement;
      if (html.hasAttribute("dark")) return true; // YouTube
      for (const el of [document.body, html]) {
        if (!el) continue;
        const c = parseRgb(getComputedStyle(el).backgroundColor);
        if (c && c.a > 0.5) return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 < 0.45;
      }
      const scheme = getComputedStyle(html).colorScheme;
      return /dark/.test(scheme) && !/light/.test(scheme);
    }
    let themeKey = "";
    function syncTheme(force = false) {
      if (!frame?.contentWindow) return;
      const dark = pageIsDark(), fs = !!document.fullscreenElement;
      const key = `${dark}|${fs}`;
      if (key === themeKey && !force) return;
      themeKey = key;
      frame.classList.toggle("dark", dark);
      const msg: ToFrame = { sl: 1, type: "theme", dark, fs };
      frame.contentWindow.postMessage(msg, new URL(browser.runtime.getURL("/")).origin);
    }
    setInterval(() => host && syncTheme(), 1000);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => syncTheme());

    // ── Mount / unmount (closed shadow root; the iframe carries the backdrop blur so the glass blurs the page) ──
    function mount() {
      if (host) return;
      host = document.createElement("signlayer-overlay");
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; }
        iframe { position: fixed; left: 0; top: 0; z-index: 2147483647; border: 0; margin: 0; padding: 0; display: block;
          color-scheme: light; background: transparent; border-radius: 30px; corner-shape: squircle; overflow: hidden;
          -webkit-backdrop-filter: blur(30px) saturate(180%); backdrop-filter: blur(30px) saturate(180%);
          box-shadow: 0 0 0 .5px rgb(0 0 0 / .06), 0 1px 2px rgb(0 0 0 / .05), 0 8px 20px -6px rgb(0 0 0 / .14), 0 28px 56px -18px rgb(0 0 0 / .26);
          transition: transform .7s ${SPRING}, width .7s ${SPRING}, height .7s ${SPRING}, border-radius .7s ${SPRING}, opacity .4s ease, scale .6s ${SPRING_BOUNCE}, box-shadow .4s ease;
          opacity: 1; scale: 1; will-change: transform; }
        iframe.dark { box-shadow: 0 0 0 .5px rgb(255 255 255 / .1), 0 1px 2px rgb(0 0 0 / .2), 0 10px 24px -6px rgb(0 0 0 / .4), 0 30px 60px -16px rgb(0 0 0 / .55); }
        iframe.enter { opacity: 0; scale: .92; }
        iframe.dragging { transition: width .7s ${SPRING}, height .7s ${SPRING}, opacity .4s ease, scale .5s ${SPRING_BOUNCE}, box-shadow .3s ease; scale: 1.03;
          box-shadow: 0 0 0 .5px rgb(0 0 0 / .06), 0 2px 4px rgb(0 0 0 / .06), 0 16px 32px -8px rgb(0 0 0 / .2), 0 40px 80px -20px rgb(0 0 0 / .32); }
        iframe.dragging.enter { scale: .92; }
        .shield { position: fixed; inset: 0; z-index: 2147483647; cursor: grabbing; background: transparent; }
        @media (prefers-reduced-motion: reduce) { iframe, iframe.dragging { transition: opacity .2s ease; scale: 1; } }`;
      frame = document.createElement("iframe");
      frame.src = browser.runtime.getURL("/overlay.html");
      frame.title = "SIGNLAYER signer";
      frame.setAttribute("allowtransparency", "true");
      frame.setAttribute("allow", "autoplay");
      frame.classList.add("dragging", "enter");
      frame.addEventListener("load", () => syncTheme(true));
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
      height = predictHeight();
      place();
      requestAnimationFrame(() => requestAnimationFrame(() => frame?.classList.remove("dragging", "enter")));
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
      syncTheme();
      watchControls();
    });
    // YouTube fullscreen: follow the control bar showing / hiding, so the card glides clear of it.
    let controlsMo: MutationObserver | null = null;
    function watchControls() {
      controlsMo?.disconnect();
      controlsMo = null;
      const fs = document.fullscreenElement;
      const yt = fs && (fs.closest?.(".html5-video-player") ?? fs.querySelector?.(".html5-video-player"));
      if (!yt) return;
      let last = yt.classList.contains("ytp-autohide");
      controlsMo = new MutationObserver(() => {
        const now = yt.classList.contains("ytp-autohide");
        if (now !== last) { last = now; place(); }
      });
      controlsMo.observe(yt, { attributes: true, attributeFilter: ["class"] });
    }

    addEventListener("message", (e: MessageEvent) => {
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as FromOverlay;
      if (m?.sl !== 1) return;
      if (m.type === "height") {
        const h = Math.ceil(m.h);
        if (performance.now() < sizeAnimUntil || h === height) return;
        height = h;
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
      if ("size" in patch || "captions" in patch) {
        // Spring the iframe straight to its new size (the card inside reflows with it), then trust the card's own height.
        height = predictHeight();
        sizeAnimUntil = performance.now() + 720;
      }
      if ("size" in patch || "corner" in patch || "captions" in patch) place();
      syncWatcher();
    });

    syncWatcher();
    const want = s.enabled && s.source === "captions" && hasCaptionSource();
    if (want) mount();
    send({ type: "hello", wantOverlay: want });
  },
});
