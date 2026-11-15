import { browser } from "wxt/browser";
import type { FromOverlay, ToBackground, ToContent } from "@/lib/messages";
import { getSettings, onSettings, setSettings, WIDTHS, type Corner, type Settings } from "@/lib/settings";

// Content script: owns the signer iframe (position, size, drag-to-corner) and watches page captions.
// The signer itself (video, captions, API calls) lives in overlay.html, an extension page.
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  async main() {
    const w = window as unknown as { __signlayer?: boolean };
    if (w.__signlayer) return; // injected twice (manifest + scripting fallback)
    w.__signlayer = true;

    let s: Settings = await getSettings();
    const MARGIN = 16;
    let host: HTMLElement | null = null;
    let frame: HTMLIFrameElement | null = null;
    let height = 360;
    let pos = { x: 0, y: 0 };
    let dragStart: { x: number; y: number } | null = null;
    let closedByUser = false;

    function place(corner: Corner = s.corner) {
      if (!frame) return;
      const fw = WIDTHS[s.size];
      const vw = document.documentElement.clientWidth || innerWidth;
      const vh = innerHeight;
      pos = { x: corner[1] === "l" ? MARGIN : vw - fw - MARGIN, y: corner[0] === "t" ? MARGIN : vh - height - MARGIN };
      frame.style.width = `${fw}px`;
      frame.style.height = `${height}px`;
      frame.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    }

    function mount() {
      if (host) return;
      host = document.createElement("signlayer-overlay");
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; }
        iframe { position: fixed; left: 0; top: 0; z-index: 2147483647; border: 0; margin: 0; padding: 0; display: block;
          color-scheme: light; background: transparent; border-radius: 26px; overflow: hidden;
          -webkit-backdrop-filter: blur(30px) saturate(190%) brightness(1.04); backdrop-filter: blur(30px) saturate(190%) brightness(1.04);
          box-shadow: 0 18px 40px -12px rgb(10 20 60 / .32), 0 2px 8px rgb(10 20 60 / .1);
          transition: transform .55s cubic-bezier(.2,.9,.25,1.05), width .45s cubic-bezier(.2,.8,.2,1), height .3s ease, opacity .3s ease; }
        iframe.dragging { transition: width .45s ease, height .3s ease; }
        iframe.gone { opacity: 0; pointer-events: none; }`;
      frame = document.createElement("iframe");
      frame.src = browser.runtime.getURL("/overlay.html");
      frame.title = "SIGNLAYER signer";
      frame.setAttribute("allowtransparency", "true");
      frame.setAttribute("allow", "autoplay");
      frame.classList.add("dragging");
      root.append(style, frame);
      document.documentElement.appendChild(host);
      place();
      requestAnimationFrame(() => requestAnimationFrame(() => frame?.classList.remove("dragging")));
    }

    function unmount() {
      host?.remove();
      host = frame = null;
    }

    addEventListener("message", (e: MessageEvent) => {
      if (!frame || e.source !== frame.contentWindow) return;
      const m = e.data as FromOverlay;
      if (m?.sl !== 1) return;
      if (m.type === "height") {
        height = Math.ceil(m.h);
        place();
      } else if (m.type === "drag") {
        if (!dragStart) {
          dragStart = { ...pos };
          frame.classList.add("dragging");
        }
        frame.style.transform = `translate(${dragStart.x + m.dx}px, ${dragStart.y + m.dy}px)`;
      } else if (m.type === "dragend") {
        if (!dragStart) return;
        const r = frame.getBoundingClientRect();
        dragStart = null;
        frame.classList.remove("dragging");
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const corner = `${cy < innerHeight / 2 ? "t" : "b"}${cx < innerWidth / 2 ? "l" : "r"}` as Corner;
        s.corner = corner;
        place(corner);
        setSettings({ corner });
      } else if (m.type === "size") {
        setSettings({ size: m.size });
      } else if (m.type === "close") {
        unmount();
        closedByUser = true;
      }
    });
    addEventListener("resize", () => place());


    browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
      const m = raw as ToContent;
      if (m?.type === "mount") {
        closedByUser = false;
        mount();
      }
      sendResponse({ ok: true });
    });

    onSettings((patch) => {
      s = { ...s, ...patch };
      if ("enabled" in patch && !s.enabled) unmount();
      if ("size" in patch || "corner" in patch) place();
      syncWatchers();
    });

    // ── Page captions (YouTube's caption renderer, or any page using the same markup) ──
    const send = (msg: ToBackground) => browser.runtime.sendMessage(msg).catch(() => {});
    const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
    let seen = "", lastSent = "", lastFlush = 0, debounce = 0;
    const recent: string[] = [];

    /** Longest k where the last k words of `prev` equal the first k words of `next` (rolling captions). */
    function overlap(prev: string[], next: string[]) {
      for (let k = Math.min(prev.length, next.length); k > 0; k--) {
        let ok = true;
        for (let i = 0; i < k; i++) if (prev[prev.length - k + i] !== next[i]) { ok = false; break; }
        if (ok) return k;
      }
      return 0;
    }

    function flush(text: string) {
      clearTimeout(debounce);
      lastFlush = Date.now();
      const words = text.split(/\s+/);
      const k = overlap(norm(lastSent).split(" ").filter(Boolean), words.map(norm));
      lastSent = text;
      const fresh = words.slice(k).join(" ").trim();
      const key = norm(fresh);
      if (!key || recent.includes(key)) return;
      recent.push(key);
      if (recent.length > 8) recent.shift();
      if (closedByUser) return;
      send({ type: "sign", text: fresh, source: "captions" });
    }

    function pollCaptions() {
      const segs = document.querySelectorAll<HTMLElement>(".ytp-caption-segment");
      if (!segs.length) return;
      const text = Array.from(segs, (el) => el.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
      if (!text || text === seen) return;
      seen = text;
      clearTimeout(debounce);
      // Auto-captions grow word by word: wait for a pause, but never hold a line longer than 1.6 s.
      if (Date.now() - lastFlush > 1600 && lastFlush) flush(text);
      else debounce = window.setTimeout(() => flush(seen), 650);
      if (!lastFlush) lastFlush = Date.now();
    }

    let captionTimer = 0;
    function syncWatchers() {
      const on = s.enabled && s.source === "captions";
      if (on && !captionTimer) captionTimer = window.setInterval(pollCaptions, 250);
      if (!on && captionTimer) {
        clearInterval(captionTimer);
        captionTimer = 0;
      }
    }
    syncWatchers();
  },
});
