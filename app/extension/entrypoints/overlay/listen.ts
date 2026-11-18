// Listening: the capture runs in the offscreen document and the background brokers start / stop. Text, the audio
// level, hints and errors for this tab come back as runtime messages.
import { browser, type Browser } from "wxt/browser";
import { OVERLAY_PORT, type ChunkInfo, type StartReply, type ToBg, type ToOverlay } from "@/lib/messages";
import { renderCaptions } from "./captions";
import { renderControls } from "./controls";
import { dot, go, stageWrap, wave } from "./dom";
import { now } from "./player";
import { sign } from "./phrases";
import { postState, render, setVoiced } from "./status";
import { s, TAB, ui } from "./state";

let port: Browser.runtime.Port | null = null;
let startToken = 0;
let micWaiting = false; // waiting for the one-time permission tab
/** While listening, a port to the background: it drops when this card goes away, and the capture stops. */
function ensurePort() {
  if (port) return;
  port = browser.runtime.connect({ name: `${OVERLAY_PORT}:${TAB}` });
  port.onDisconnect.addListener(() => { port = null; if (ui.listening !== "off") ensurePort(); }); // the worker restarted
}
const toBg = <T>(m: ToBg) => browser.runtime.sendMessage(m) as Promise<T>;

export async function startListening() {
  ui.errorText = ""; ui.hint = "";
  ui.listening = "starting";
  renderControls();
  render();
  if (!TAB) return fail("This card lost track of its tab. Close it and click the Flux icon again.");
  ensurePort();
  const token = ++startToken;
  const r = await toBg<StartReply>({ target: "bg", type: "start", tabId: TAB, source: s.source, apiUrl: s.apiUrl })
    .catch((e): StartReply => ({ ok: false, error: `The extension didn't answer (${String(e).slice(0, 60)}). Try again.` }));
  if (token !== startToken) return; // stopped while starting
  if (r.ok) ui.listening = "on";
  else if (r.error === "mic-denied") return openMicTab();
  else if (!r.error) ui.listening = "off";
  else return fail(r.error);
  renderControls();
  render();
}

export function stopListening() {
  const was = ui.listening !== "off" || micWaiting;
  startToken++;
  micWaiting = false;
  ui.listening = "off";
  ui.hint = "";
  if (!now.job) now.heardText = "";
  if (was && TAB) toBg({ target: "bg", type: "stop", tabId: TAB }).catch(() => {});
  setLevel(0, false);
  renderControls();
  renderCaptions();
  render();
}

function fail(text: string) {
  startToken++;
  if (ui.listening !== "off" && TAB) toBg({ target: "bg", type: "stop", tabId: TAB }).catch(() => {});
  ui.listening = "off";
  ui.errorText = text;
  setLevel(0, false);
  renderControls();
  render();
}

function openMicTab() {
  micWaiting = true;
  ui.listening = "starting";
  ui.hint = "Allow the microphone in the tab that just opened. Listening starts by itself.";
  toBg({ target: "bg", type: "open-mic", tabId: TAB }).catch(() => {});
  renderControls();
  render();
}

let lvlRaf = 0, lvl = 0;
function setLevel(x: number, v: boolean) {
  lvl = x;
  if (setVoiced(v)) postState();
  wave.set(x, v, ui.listening === "on");
  if (!lvlRaf) lvlRaf = requestAnimationFrame(() => {
    lvlRaf = 0;
    go.style.setProperty("--lvl", lvl.toFixed(3));
    dot.style.setProperty("--lvl", lvl.toFixed(3));
    stageWrap.style.setProperty("--lvl", lvl.toFixed(3));
  });
}

/** Diagnostics for scripts/verify.mjs: every chunk the server transcribed. */
const tabDebug = { chunks: [] as ChunkInfo[] };

export function initListen() {
  (globalThis as { __slTab?: typeof tabDebug }).__slTab = tabDebug;
  browser.runtime.onMessage.addListener((raw: unknown) => {
    const m = raw as ToOverlay | { type?: string; target?: string };
    // The permission tab tells us when the mic is allowed.
    if (m?.type === "mic-granted") {
      if (!micWaiting) return;
      micWaiting = false;
      ui.hint = "";
      if (s.source === "mic") startListening();
      return;
    }
    if ((m as ToOverlay).target !== "overlay" || (m as ToOverlay).tabId !== TAB) return;
    const e = m as ToOverlay;
    if (e.type === "level") { if (ui.listening === "on") setLevel(e.v, e.voiced); return; }
    if (ui.listening === "off" && e.type !== "stopped") return;
    if (e.type === "chunk") { tabDebug.chunks.push(e.chunk); if (tabDebug.chunks.length > 50) tabDebug.chunks.shift(); }
    else if (e.type === "text") sign(e.text);
    else if (e.type === "hint") { ui.hint = e.text; render(); }
    else if (e.type === "error") fail(e.text);
    else if (e.type === "stopped") { startToken++; ui.listening = "off"; ui.hint = e.reason; setLevel(0, false); renderControls(); render(); }
  });
}
