// Talking to the frame around us (float.ts, in the page): the card's size and the viewport, the drag grip, close.
import { SIZE_PX } from "@/lib/settings";
import { card, closeBtn, gear, grip, sizeSeg, stageWrap } from "./dom";
import { stopListening } from "./listen";
import { s } from "./state";

/** Nothing private goes to the page: sizes, drag deltas, state. */
export const toFrame = (m: object) => parent.postMessage({ sl: 1, ...m }, "*");

let vpH = 10_000;
/** The stage takes what the viewport leaves (never under 150 px), up to its natural 3:4. */
export function fitStage() {
  const pad = 2 * (parseFloat(getComputedStyle(card).paddingLeft) || 10);
  const natural = (SIZE_PX[s.size] - pad) * 4 / 3;
  const other = card.offsetHeight - stageWrap.offsetHeight;
  const h = Math.max(150, Math.min(natural, vpH - 16 - other));
  stageWrap.style.height = `${Math.floor(h)}px`;
}
export function applySize() {
  card.dataset.size = s.size;
  card.style.width = `${SIZE_PX[s.size]}px`;
  sizeSeg.dataset.size = s.size;
  sizeSeg.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.size === s.size)));
  fitStage();
}

// Drag by the header: the frame (float.ts) lays a transparent grip over the header's non-button part and drags
// the card in page coordinates. We tell it where that part is (up to the gear).
let gripKey = "";
function postGrip() {
  const g = grip.getBoundingClientRect(), b = gear.getBoundingClientRect();
  const r = { x: Math.round(g.left), y: Math.round(g.top), w: Math.round(b.left - 4 - g.left), h: Math.round(g.height) };
  const key = JSON.stringify(r);
  if (key !== gripKey) { gripKey = key; toFrame({ type: "grip", ...r }); }
}

export function initFrame() {
  new ResizeObserver(() => {
    const r = card.getBoundingClientRect();
    toFrame({ type: "layout", w: r.width, h: r.height });
    gripKey = ""; postGrip();
  }).observe(card);
  addEventListener("message", (e) => {
    if (e.source !== parent || (e.data as { sl?: number })?.sl !== 1) return;
    const m = e.data as { type: string; h?: number };
    if (m.type === "viewport" && m.h) { vpH = m.h; fitStage(); }
    if (m.type === "closing") stopListening();
  });
  new ResizeObserver(postGrip).observe(grip);
  closeBtn.addEventListener("click", () => { stopListening(); toFrame({ type: "close" }); });
}
