// The transcript: words blur in, the word being signed is highlighted (captionFrame from app/core).
import { captionFrame } from "@flux/core";
import { esc } from "@/lib/brand";
import { cc } from "./dom";
import { blocked, now } from "./player";
import { s } from "./state";

const chunkSize = () => (s.size === "s" ? 5 : s.size === "m" ? 6 : 8);
let chunkKey = "";
/** Redraw the words on the next renderCaptions (the card size changed). */
export function resetCaptions() { chunkKey = ""; }

export function renderCaptions() {
  const { job, idx, heardText, pending } = now;
  const CHUNK = chunkSize();
  cc.classList.toggle("pending", pending && !job && !!heardText);
  if (heardText && !job) {
    const ws = heardText.split(/\s+/).filter(Boolean).slice(-CHUNK - 2);
    const key = `heard|${heardText}|${CHUNK}`;
    if (key !== chunkKey) {
      chunkKey = key;
      cc.innerHTML = `<i class="hl"></i>${ws.map((w, k) => `<span class="w heard" style="--k:${k}">${esc(w)}</span>`).join(" ")}`;
    }
    return;
  }
  const j = job ?? now.shown;
  if (!j) {
    if (cc.innerHTML) cc.innerHTML = "";
    chunkKey = "";
    return;
  }
  const res = j.res;
  const playing = job ? idx : res.playlist.length;
  // Not signed (safety gate): the words simply stay as heard.
  const frame = res.playlist.length && !blocked(j) ? captionFrame(res, res.words.length, playing) : null;
  const states = frame?.states ?? res.words.map(() => "heard" as const);
  // Balanced chunks (never a lone last word).
  const len = res.words.length;
  const n = Math.ceil(len / Math.max(1, Math.ceil(len / CHUNK)));
  let focus = states.indexOf("now");
  if (focus < 0) focus = job ? Math.max(0, states.lastIndexOf("signed")) : len - 1;
  const start = Math.floor(Math.max(0, focus) / n) * n;
  const key = `${res.text}|${start}|${n}`;
  if (key !== chunkKey) {
    chunkKey = key;
    cc.innerHTML = `<i class="hl"></i>` + res.words.slice(start, start + n).map((w, k) => `<span class="w" data-i="${start + k}" style="--k:${k}">${esc(w)}</span>`).join(" ");
  }
  let cur: HTMLElement | null = null;
  cc.querySelectorAll<HTMLElement>(".w").forEach((el) => {
    const st = states[Number(el.dataset.i)] ?? "upcoming";
    el.classList.toggle("heard", st === "heard");
    el.classList.toggle("signed", st === "signed");
    el.classList.toggle("now", st === "now");
    if (st === "now") cur = el;
  });
  const hl = cc.querySelector<HTMLElement>(".hl")!;
  const target = cur as HTMLElement | null;
  if (target) {
    hl.style.transform = `translate(${target.offsetLeft - 4}px, ${target.offsetTop}px)`;
    hl.style.width = `${target.offsetWidth + 8}px`;
    hl.style.height = `${target.offsetHeight}px`;
    hl.classList.add("show");
  } else hl.classList.remove("show");
}
