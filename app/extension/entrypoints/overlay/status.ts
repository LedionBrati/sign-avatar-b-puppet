// What the card is doing (one view), shown as a tiny coloured dot by the wordmark (the label is for screen readers),
// the frame's glow (float.ts), and one small line under the transcript for real problems.
import { esc } from "@/lib/brand";
import type { Source } from "@/lib/settings";
import { cc, dot, note, stage, statusEl } from "./dom";
import { fitStage, toFrame } from "./frame";
import { checkHealth } from "./health";
import { openServerForm } from "./menu";
import { now, showNeutral } from "./player";
import { s, ui } from "./state";

type View = "ready" | "starting" | "listening" | "signing" | "offline" | "error";
type Tone = "live" | "sign" | "off" | "idle";
const SRC_LABEL: Record<Source, string> = { mic: "Mic", tab: "Tab" };
const LABEL: Record<View, string> = { ready: "Ready", starting: "Starting", listening: "Listening", signing: "Signing", offline: "Offline", error: "Off" };

function view(): View {
  if (ui.isOffline) return "offline";
  if (ui.errorText) return "error";
  if (now.job) return "signing";
  if (ui.listening === "starting") return "starting";
  if (ui.listening === "on") return "listening";
  return "ready";
}

let voiced = false;
/** Speech detected right now (the frame glows with it). True when it changed. */
export function setVoiced(v: boolean) {
  if (v === voiced) return false;
  voiced = v;
  return true;
}
let stateKey = "";
export function postState(tone = dot.dataset.tone ?? "idle") {
  const key = `${tone}|${voiced}`;
  if (key === stateKey) return;
  stateKey = key;
  toFrame({ type: "state", tone, voice: voiced });
}

function setStatus(tone: Tone, label: string) {
  postState(tone);
  dot.dataset.tone = tone;
  if (statusEl.textContent !== label) statusEl.textContent = label;
}

export function render() {
  const v = view();
  stage.dataset.state = v;
  document.body.dataset.state = v;
  document.body.dataset.listening = ui.listening;
  const tone: Tone = v === "signing" ? "sign" : v === "listening" ? "live" : v === "offline" || v === "error" ? "off" : "idle";
  setStatus(tone, v === "listening" ? `${LABEL[v]} to ${SRC_LABEL[s.source]}` : LABEL[v]);
  renderNote(v);
  if (v !== "signing") showNeutral();
}

// Real problems that need the user (server unreachable, capture off): one small, clean line under the transcript.
let noteKey = "";
function renderNote(v: View) {
  const html = v === "offline"
    ? `<span>${ui.offlineMsg}</span><button type="button" data-act="server">Set server</button><button type="button" data-act="retry">Retry</button>`
    : v === "error" ? `<span>${esc(ui.errorText)}</span>` : "";
  if (html !== noteKey) {
    noteKey = html;
    note.innerHTML = html;
    fitStage();
  }
  cc.dataset.empty = ui.hint ? ui.hint
    : v === "listening" ? (s.source === "tab" ? "Listening to this tab…" : "Listening… speak near your computer.")
    : v === "starting" ? ""
    : s.source === "tab" ? "Play something in this tab, then press Start."
    : "Press Start and speak.";
}

export function initStatus() {
  note.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]")?.dataset.act;
    if (act === "retry") checkHealth();
    if (act === "server") openServerForm();
  });
}
