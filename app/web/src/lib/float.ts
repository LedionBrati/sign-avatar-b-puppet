// The floating signer card: drag it anywhere by its header (pointer or arrow keys), pick a size (S/M/L), and it
// remembers both (localStorage, best effort). It always stays inside the viewport. On phones (<= 600px) it docks
// full width instead, so there is nothing to drag.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

export type FloatSize = "s" | "m" | "l";
interface Saved { x?: number; y?: number; size?: FloatSize }

const KEY = "sl-float";
const PAD = 12; // keep this much of the viewport around the card
const TOP = 72; // and stay clear of the top bar
const DOCK = "(max-width: 600px)";

function load(): Saved {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") as Saved; } catch { return {}; }
}
function save(s: Saved) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...s })); } catch { /* private mode */ }
}

export function useFloat(card: RefObject<HTMLElement | null>) {
  const [size, setSizeState] = useState<FloatSize>(() => { const s = load().size; return s === "s" || s === "l" ? s : "m"; });
  const [docked, setDocked] = useState(() => typeof matchMedia === "function" && matchMedia(DOCK).matches);
  const [dragging, setDragging] = useState(false);
  const pos = useRef<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);

  const place = useCallback((x: number, y: number) => {
    const el = card.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const maxX = Math.max(PAD, innerWidth - w - PAD), maxY = Math.max(TOP, innerHeight - h - PAD);
    const p = { x: Math.round(Math.min(maxX, Math.max(PAD, x))), y: Math.round(Math.min(maxY, Math.max(TOP, y))) };
    pos.current = p;
    el.style.setProperty("--fx", `${p.x}px`);
    el.style.setProperty("--fy", `${p.y}px`);
  }, [card]);

  // First placement: the remembered spot, else centred under the top bar.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || docked) return;
    const s = load();
    const x = s.x ?? (innerWidth - el.offsetWidth) / 2;
    const y = s.y ?? Math.max(TOP, (innerHeight - el.offsetHeight) / 2 + 12);
    place(x, y);
    el.dataset.placed = "1";
  }, [card, docked, place]);

  // Re-clamp whenever the card or the window changes size (typing row, size switch, rotation).
  useEffect(() => {
    const el = card.current;
    if (!el || docked) return;
    const again = () => { if (pos.current) place(pos.current.x, pos.current.y); };
    const ro = new ResizeObserver(again);
    ro.observe(el);
    addEventListener("resize", again);
    return () => { ro.disconnect(); removeEventListener("resize", again); };
  }, [card, docked, place]);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(DOCK);
    const on = () => setDocked(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  const setSize = useCallback((s: FloatSize) => { setSizeState(s); save({ size: s }); }, []);

  const handle = {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (docked || e.button !== 0 || (e.target as Element).closest("button, input, a, [role=radio]")) return;
      const p = pos.current;
      if (!p) return;
      drag.current = { id: e.pointerId, dx: e.clientX - p.x, dy: e.clientY - p.y };
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      place(e.clientX - d.dx, e.clientY - d.dy);
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      setDragging(false);
      if (pos.current) save(pos.current);
    },
    onKeyDown(e: KeyboardEvent<HTMLElement>) {
      if (docked || !pos.current || e.target !== e.currentTarget) return;
      const step = e.shiftKey ? 64 : 24;
      const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!mv) return;
      e.preventDefault();
      place(pos.current.x + mv[0]!, pos.current.y + mv[1]!);
      save(pos.current);
    },
  };

  return { size, setSize, docked, dragging, handle };
}
