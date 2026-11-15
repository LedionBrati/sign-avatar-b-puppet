import { browser, type Browser } from "wxt/browser";
import { createSignClient } from "@signlayer/core";
import type { HealthResult, TabAudioState, TabAudioStatus, ToBackground, ToOverlay } from "@/lib/messages";
import { getSettings, onSettings, type Source } from "@/lib/settings";

// Background service worker: message routing to each tab's signer, context menu, shortcuts, health check,
// and tab audio (tabCapture stream id -> offscreen document that records + transcribes).
export default defineBackground(() => {
  const ports = new Map<number, Browser.runtime.Port>();
  const pending = new Map<number, ToOverlay[]>();
  /** Last status per tab, replayed when a signer (re)connects, e.g. after the iframe reloads. */
  const lastState = new Map<number, ToOverlay[]>();

  browser.runtime.onConnect.addListener((port) => {
    const tabId = port.sender?.tab?.id;
    if (port.name !== "overlay" || tabId == null) return;
    ports.set(tabId, port);
    for (const m of lastState.get(tabId) ?? []) port.postMessage(m);
    for (const m of pending.get(tabId) ?? []) port.postMessage(m);
    pending.delete(tabId);
    port.onDisconnect.addListener(() => {
      if (ports.get(tabId) === port) ports.delete(tabId);
    });
  });

  function remember(tabId: number, msg: ToOverlay) {
    if (msg.type !== "source-state" && msg.type !== "tab-audio-state") return;
    const list = (lastState.get(tabId) ?? []).filter((m) => m.type !== msg.type);
    list.push(msg);
    lastState.set(tabId, list);
  }

  /** Deliver to the tab's signer, mounting it first if needed (injecting the content script into tabs opened before install). */
  async function toOverlay(tabId: number, msg: ToOverlay, { mount = true } = {}) {
    remember(tabId, msg);
    const port = ports.get(tabId);
    if (port) {
      try {
        port.postMessage(msg);
        return;
      } catch {
        ports.delete(tabId);
      }
    }
    if (msg.type === "source-state" || msg.type === "tab-audio-state" || msg.type === "reset") return; // replayed on connect
    const q = pending.get(tabId) ?? [];
    q.push(msg);
    pending.set(tabId, q.slice(-4));
    if (mount) await mountIn(tabId);
  }

  async function mountIn(tabId: number) {
    try {
      await browser.tabs.sendMessage(tabId, { type: "mount" });
    } catch {
      try {
        await browser.scripting.executeScript({ target: { tabId }, files: ["/content-scripts/content.js"] });
        await browser.tabs.sendMessage(tabId, { type: "mount" });
      } catch (e) {
        // Not ready yet (the content script says "hello" when it is, and we flush then) or a page we can't script.
        console.debug("[signlayer] tab not ready", tabId, e instanceof Error ? e.message : e);
      }
    }
  }

  async function activeTabId() {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id;
  }

  async function health(): Promise<HealthResult> {
    const { apiUrl } = await getSettings();
    try {
      const h = await createSignClient(apiUrl, { timeoutMs: 4000 }).health();
      return { ok: true, signs: h.signs, semantic: h.semantic, agent: h.agent, transcribe: h.transcribe, url: apiUrl };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), url: apiUrl };
    }
  }

  // ── Tab audio: tabCapture stream id -> offscreen document (USER_MEDIA) ──
  let tabAudio: TabAudioStatus = { tabId: null, state: "off" };
  const OFFSCREEN = "/offscreen.html";

  async function ensureOffscreen() {
    const has = await browser.offscreen.hasDocument?.();
    if (has) return;
    await browser.offscreen.createDocument({
      url: OFFSCREEN,
      reasons: [browser.offscreen.Reason.USER_MEDIA],
      justification: "Record this tab's audio and send short chunks to the SIGNLAYER speech-to-text API",
    });
  }

  function setTabAudio(tabId: number, state: TabAudioState, detail?: string) {
    tabAudio = { tabId, state, detail };
    toOverlay(tabId, { type: "tab-audio-state", state, detail }, { mount: state !== "off" });
    browser.action.setBadgeText({ text: state === "listening" ? "ON" : "" }).catch(() => {});
    browser.action.setBadgeBackgroundColor({ color: "#1f3fd6" }).catch(() => {});
  }

  async function startTabAudio(tabId: number) {
    if (tabAudio.tabId === tabId && (tabAudio.state === "listening" || tabAudio.state === "starting")) return { ok: true };
    if (tabAudio.tabId != null && tabAudio.tabId !== tabId) await stopTabAudio();
    setTabAudio(tabId, "starting");
    try {
      const streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
      await ensureOffscreen();
      const { apiUrl } = await getSettings();
      await browser.runtime.sendMessage({ target: "offscreen", type: "start", streamId, tabId, apiUrl });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // "Extension has not been invoked for the current page": tabCapture needs a click on the toolbar icon (or the shortcut).
      const detail = /invoked|activeTab|permission/i.test(msg) ? "Click the SIGNLAYER icon in the toolbar to share this tab's audio" : msg;
      setTabAudio(tabId, "error", detail);
      return { ok: false, error: detail };
    }
  }

  async function stopTabAudio() {
    const tabId = tabAudio.tabId;
    if (tabId == null) return;
    try { await browser.runtime.sendMessage({ target: "offscreen", type: "stop" }); } catch { /* not running */ }
    try { if (await browser.offscreen.hasDocument?.()) await browser.offscreen.closeDocument(); } catch { /* gone */ }
    setTabAudio(tabId, "off");
    tabAudio = { tabId: null, state: "off" };
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    ports.delete(tabId);
    pending.delete(tabId);
    lastState.delete(tabId);
    if (tabAudio.tabId === tabId) stopTabAudio();
  });

  onSettings((patch) => {
    if (patch.enabled === false || (patch.source && patch.source !== "tab")) stopTabAudio();
  });

  // ── Context menu + shortcuts ──
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.removeAll().then(() =>
      browser.contextMenus.create({ id: "sl-sign", title: "Sign with SIGNLAYER", contexts: ["selection"] }),
    );
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "sl-sign" || tab?.id == null || !info.selectionText) return;
    toOverlay(tab.id, { type: "sign", text: info.selectionText, source: "selection", origin: "selection" });
  });

  async function selectionIn(tabId: number) {
    const [r] = await browser.scripting.executeScript({ target: { tabId }, func: () => getSelection()?.toString() ?? "" });
    return (r?.result as string | undefined)?.trim() ?? "";
  }

  browser.commands.onCommand.addListener(async (command, tab) => {
    const tabId = tab?.id ?? (await activeTabId());
    if (tabId == null) return;
    if (command === "sign-selection") {
      const text = await selectionIn(tabId).catch(() => "");
      if (text) toOverlay(tabId, { type: "sign", text, source: "selection", origin: "selection" });
    } else if (command === "toggle-signer") {
      const s = await getSettings();
      let mounted = false;
      try {
        mounted = Boolean(((await browser.tabs.sendMessage(tabId, { type: "toggle" })) as { mounted?: boolean })?.mounted);
      } catch {
        await mountIn(tabId);
        mounted = true;
      }
      // The shortcut counts as invoking the extension, so it can start tab audio too.
      if (s.enabled && s.source === "tab") {
        if (mounted) startTabAudio(tabId);
        else if (tabAudio.tabId === tabId) stopTabAudio();
      }
    }
  });

  // ── Messages ──
  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as ToBackground & { target?: string };
    if ((msg as { target?: string }).target === "offscreen") return; // for the offscreen document
    switch (msg?.type) {
      case "health":
        health().then(sendResponse);
        return true;
      case "sign":
      case "heard":
        (async () => {
          const tabId = msg.tabId ?? (msg.target === "active" || !sender.tab ? await activeTabId() : sender.tab.id);
          if (tabId != null) {
            await toOverlay(tabId, msg.type === "sign"
              ? { type: "sign", text: msg.text, source: msg.source, origin: msg.origin, next: msg.next }
              : { type: "heard", text: msg.text, source: msg.source });
          }
          sendResponse({ ok: tabId != null });
        })();
        return true;
      case "source-state":
        if (sender.tab?.id != null) toOverlay(sender.tab.id, { type: "source-state", state: msg.state }, { mount: false });
        return;
      case "reset":
        if (sender.tab?.id != null) toOverlay(sender.tab.id, { type: "reset" }, { mount: false });
        return;
      case "hello":
        if (sender.tab?.id != null && pending.get(sender.tab.id)?.length) mountIn(sender.tab.id);
        return;
      case "mount-active":
        activeTabId().then((id) => { if (id != null) mountIn(id); });
        return;
      case "tab-audio":
        (async () => {
          const tabId = msg.tabId ?? (await activeTabId());
          if (tabId == null) return sendResponse({ ok: false, error: "no tab" });
          sendResponse(msg.on ? await startTabAudio(tabId) : (await stopTabAudio(), { ok: true }));
        })();
        return true;
      case "tab-audio-status":
        sendResponse(tabAudio);
        return;
      case "tab-audio-state":
        if (msg.state === "error" || msg.state === "off") {
          setTabAudio(msg.tabId, msg.state, msg.detail);
          if (msg.state === "off") tabAudio = { tabId: null, state: "off" };
        } else {
          if (msg.state !== tabAudio.state || msg.tabId !== tabAudio.tabId) setTabAudio(msg.tabId, msg.state, msg.detail);
          else if (msg.level != null) ports.get(msg.tabId)?.postMessage({ type: "tab-audio-state", state: msg.state, level: msg.level } satisfies ToOverlay);
        }
        return;
      case "tab-audio-text":
        toOverlay(msg.tabId, { type: "sign", text: msg.text, source: "tab", origin: "tab", latency_ms: msg.latency_ms });
        return;
    }
  });

  // Test hooks (puppeteer verification): sign text in a tab exactly like the context menu does; read tab audio state.
  const g = globalThis as { __slSign?: unknown; __slTabAudio?: unknown };
  g.__slSign = (tabId: number, text: string, source: Source = "selection") =>
    toOverlay(tabId, { type: "sign", text, source, origin: "selection" });
  g.__slTabAudio = () => tabAudio;
});
