// The voice band's controls: Mic | Tab, and Start / Stop.
import { ICON, $ } from "@/lib/brand";
import { setSettings, type Source } from "@/lib/settings";
import { go, seg } from "./dom";
import { startListening, stopListening } from "./listen";
import { render } from "./status";
import { s, ui } from "./state";

export function renderControls() {
  seg.dataset.src = s.source;
  seg.querySelectorAll<HTMLButtonElement>("[data-src]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.src === s.source)));
  const on = ui.listening !== "off";
  go.setAttribute("aria-pressed", String(on));
  go.classList.toggle("starting", ui.listening === "starting");
  $("goIc").innerHTML = on ? ICON.stop : ICON.play;
  const label = ui.listening === "starting" ? "Starting…" : on ? "Stop" : s.source === "tab" ? "Listen to this tab" : "Start listening";
  go.setAttribute("aria-label", label);
  go.title = label;
}

export function initControls() {
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-src]");
    if (!b || b.dataset.src === s.source) return;
    const was = ui.listening !== "off";
    stopListening();
    s.source = b.dataset.src as Source;
    setSettings({ source: s.source });
    ui.errorText = "";
    renderControls();
    render();
    if (was) startListening();
  });
  seg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const other = seg.querySelector<HTMLButtonElement>(`[data-src="${s.source === "mic" ? "tab" : "mic"}"]`)!;
    other.click();
    other.focus();
  });
  go.addEventListener("click", () => (ui.listening === "off" ? startListening() : stopListening()));
}
