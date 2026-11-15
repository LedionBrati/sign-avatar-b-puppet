import { browser, type Browser } from "wxt/browser";
import { captureError } from "@/lib/capture";
import { OVERLAY_PORT, type StartReply, type ToBg, type ToOffscreen, type ToOverlay } from "@/lib/messages";

// Background jobs:
//  1. Toolbar click: toggle the floating card on that tab (inject float.js). The click is an action invocation, so
//     Chrome grants activeTab on the tab, which is what tabCapture.getMediaStreamId needs later, on Start.
//     If Tab audio was running on another tab, the new card starts listening here at once (the old card is told).
//  2. Start / Stop from a card: get the tab's stream id, hand it to the offscreen document (which captures).
//  3. A card closes or its page navigates (its port drops): stop that tab's capture.

type Capturing = { tabId: number; source: "tab" | "mic" } | null;
const getCapturing = async () => ((await browser.storage.session.get("capturing")).capturing ?? null) as Capturing;
const setCapturing = (c: Capturing) => browser.storage.session.set({ capturing: c });

let creating: Promise<void> | null = null;
async function ensureOffscreen() {
  const have = await browser.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as Browser.runtime.ContextType] });
  if (have.length) return;
  creating ??= browser.offscreen
    .createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA" as Browser.offscreen.Reason], justification: "Capture tab audio or the microphone and transcribe it for the signer." })
    .catch((e) => { if (!/single offscreen|already/i.test(String(e))) throw e; })
    .finally(() => { creating = null; });
  await creating;
}

async function toOffscreen<T>(m: ToOffscreen): Promise<T> {
  await ensureOffscreen();
  for (let i = 0; ; i++) {
    try {
      return (await browser.runtime.sendMessage(m)) as T;
    } catch (e) {
      if (i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 100)); // the document is still loading its script
    }
  }
}

async function start(m: Extract<ToBg, { type: "start" }>): Promise<StartReply> {
  let streamId: string | undefined;
  if (m.source === "tab") {
    // A tab with an active capture can't be captured again: stop ours first.
    const cap = await getCapturing();
    if (cap) await toOffscreen({ target: "offscreen", type: "stop", tabId: cap.tabId, reason: cap.tabId !== m.tabId ? "Listening moved to another tab." : "" }).catch(() => {});
    try {
      streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: m.tabId });
    } catch (e) {
      return { ok: false, error: captureError(e) };
    }
  }
  const r = await toOffscreen<StartReply>({ target: "offscreen", type: "start", tabId: m.tabId, kind: m.source, streamId, apiUrl: m.apiUrl })
    .catch((e): StartReply => ({ ok: false, error: `The audio helper didn't start (${String(e).slice(0, 80)})` }));
  if (r?.ok) await setCapturing({ tabId: m.tabId, source: m.source });
  return r ?? { ok: false, error: "The audio helper didn't answer." };
}

async function stop(tabId: number) {
  const cap = await getCapturing();
  if (cap?.tabId === tabId) await setCapturing(null);
  // Also when nothing is recorded yet: a start may still be on its way. (The offscreen document ignores other tabs.)
  const have = await browser.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as Browser.runtime.ContextType] });
  if (have.length) await browser.runtime.sendMessage({ target: "offscreen", type: "stop", tabId } satisfies ToOffscreen).catch(() => {});
}

/** Toolbar click: open the card (or close it if it is open). Chrome pages can't be injected: say so on the icon. */
async function toggle(tab: Browser.tabs.Tab) {
  const tabId = tab.id;
  if (tabId == null) return;
  const cap = await getCapturing();
  const autostart = cap?.source === "tab" && cap.tabId !== tabId ? "tab" : "";
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      func: (id: number, auto: string) => { Object.assign(globalThis, { __slTabId: id, __slAutostart: auto }); },
      args: [tabId, autostart],
    });
    await browser.scripting.executeScript({ target: { tabId }, files: ["/float.js"] });
  } catch (e) {
    console.warn("[signlayer] can't open the card here", e);
    await browser.action.setBadgeBackgroundColor({ tabId, color: "#1f3fd6" }).catch(() => {});
    await browser.action.setBadgeText({ tabId, text: "!" }).catch(() => {});
    await browser.action.setTitle({ tabId, title: "SIGNLAYER can't open on this page (Chrome pages and the Web Store are off-limits). Try a regular website." }).catch(() => {});
    setTimeout(() => {
      browser.action.setBadgeText({ tabId, text: "" }).catch(() => {});
      browser.action.setTitle({ tabId, title: "SIGNLAYER" }).catch(() => {});
    }, 5000);
  }
}

export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => { void toggle(tab); });

  browser.runtime.onMessage.addListener((raw: unknown, sender, reply: (r: unknown) => void) => {
    const m = raw as ToBg | ToOverlay;
    if (m?.target === "overlay") {
      // Seen on its way to a card: keep track of what is capturing.
      if (m.type === "stopped" || m.type === "error") void getCapturing().then((c) => { if (c?.tabId === m.tabId) return setCapturing(null); });
      return;
    }
    if (m?.target !== "bg") return;
    const tabId = m.tabId ?? sender.tab?.id;
    if (m.type === "start") { start({ ...m, tabId }).then(reply); return true; }
    if (m.type === "stop") { stop(tabId).then(() => reply({ ok: true })); return true; }
    if (m.type === "open-mic") {
      browser.tabs.create({ url: browser.runtime.getURL("/mic.html"), openerTabId: tabId, index: sender.tab ? sender.tab.index + 1 : undefined }).catch(() => {});
      return;
    }
  });

  // A card keeps a port open while it listens; it drops when the card closes or the page goes away.
  browser.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith(OVERLAY_PORT)) return;
    const tabId = Number(port.name.split(":")[1]) || port.sender?.tab?.id;
    port.onDisconnect.addListener(() => { if (tabId) void stop(tabId); });
  });

  browser.tabs.onRemoved.addListener((tabId) => { void getCapturing().then((c) => { if (c?.tabId === tabId) return stop(tabId); }); });
});
