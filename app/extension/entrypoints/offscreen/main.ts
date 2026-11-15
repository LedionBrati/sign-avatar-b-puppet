import { browser } from "wxt/browser";
import { captureError, Chunker } from "@/lib/capture";
import type { StartReply, ToOffscreen, ToOverlay } from "@/lib/messages";
import type { Source } from "@/lib/settings";

// The offscreen document does all audio work, so it never depends on the page the card sits on (its permissions
// policy, CSP, or focus). One capture at a time: starting on another tab stops the previous one and tells that card.
//   tab: the background gets a stream id with tabCapture.getMediaStreamId({ targetTabId }) (activeTab, from the
//        toolbar click) ─► getUserMedia({ chromeMediaSource: "tab" }) here ─► Chunker (also keeps the tab audible).
//   mic: getUserMedia({ audio }) here (the extension origin is granted once in mic.html) ─► Chunker.

let cur: { tabId: number; kind: Source; chunker: Chunker } | null = null;
let starting = 0, startingTab: number | null = null;

const send = (m: ToOverlay) => browser.runtime.sendMessage(m).catch(() => {});

function stop(tabId?: number, reason = "") {
  if (startingTab != null && (tabId == null || tabId === startingTab)) { starting++; startingTab = null; } // cancel a start in flight
  if (!cur || (tabId != null && cur.tabId !== tabId)) return;
  const was = cur;
  cur = null;
  was.chunker.stop();
  if (reason) send({ target: "overlay", tabId: was.tabId, type: "stopped", reason });
}

async function start(m: Extract<ToOffscreen, { type: "start" }>): Promise<StartReply> {
  if (cur) stop(undefined, cur.tabId !== m.tabId ? "Listening moved to another tab." : "");
  const token = ++starting;
  startingTab = m.tabId;
  let stream: MediaStream;
  try {
    stream = m.kind === "tab"
      ? await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: m.streamId } } as unknown as MediaTrackConstraints,
          video: false,
        })
      : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    if (m.kind === "tab") return { ok: false, error: captureError(e) };
    const name = e instanceof Error ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return { ok: false, error: "mic-denied" };
    if (name === "NotFoundError" || name === "OverconstrainedError") return { ok: false, error: "No microphone found. Plug one in and press Start." };
    return { ok: false, error: `Can't open the microphone (${String(e).slice(0, 80)})` };
  }
  if (token !== starting) { stream.getTracks().forEach((t) => t.stop()); return { ok: false, error: "" }; }
  startingTab = null;
  const tabId = m.tabId;
  const chunker = new Chunker(stream, m.apiUrl, {
    onText: (text, chunk) => send({ target: "overlay", tabId, type: "text", text, chunk }),
    onChunk: (chunk) => send({ target: "overlay", tabId, type: "chunk", chunk }),
    onLevel: (v, voiced) => send({ target: "overlay", tabId, type: "level", v: Math.round(v * 1000) / 1000, voiced }),
    onHint: (text) => send({ target: "overlay", tabId, type: "hint", text }),
    onError: (text) => { if (cur?.chunker === chunker) cur = null; send({ target: "overlay", tabId, type: "error", text }); },
  }, {
    monitor: m.kind === "tab",
    silentHint: m.kind === "tab" ? "No sound from this tab yet. Press play, or unmute the video or call." : "Nothing heard yet. Speak near your computer.",
    // A browser extension can't hear desktop apps (the Zoom / Teams app): only browser tabs, or the microphone.
    silentHint2: m.kind === "tab" ? "Still silent. In a Zoom app call? Join from the browser, or use Mic." : undefined,
  });
  cur = { tabId, kind: m.kind, chunker };
  await chunker.start();
  return { ok: true };
}

browser.runtime.onMessage.addListener((raw: unknown, _sender, reply: (r: unknown) => void) => {
  const m = raw as ToOffscreen;
  if (m?.target !== "offscreen") return;
  if (m.type === "start") { start(m).then(reply, (e) => reply({ ok: false, error: String(e) })); return true; }
  if (m.type === "stop") { stop(m.tabId, m.reason); reply({ ok: true }); return; }
  if (m.type === "status") { reply({ tabId: cur?.tabId ?? null, kind: cur?.kind ?? null }); return; }
});
