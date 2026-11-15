import { browser, type Browser } from "wxt/browser";
import { createSignClient } from "@signlayer/core";
import type { HealthResult, ToBackground, ToOverlay } from "@/lib/messages";
import { getSettings } from "@/lib/settings";

// Background service worker: context menu, keyboard shortcut, message routing to each tab's overlay, health check.
export default defineBackground(() => {
  const ports = new Map<number, Browser.runtime.Port>();
  const pending = new Map<number, ToOverlay[]>();

  browser.runtime.onConnect.addListener((port) => {
    const tabId = port.sender?.tab?.id;
    if (port.name !== "overlay" || tabId == null) return;
    ports.set(tabId, port);
    for (const m of pending.get(tabId) ?? []) port.postMessage(m);
    pending.delete(tabId);
    port.onDisconnect.addListener(() => {
      if (ports.get(tabId) === port) ports.delete(tabId);
    });
  });

  /** Deliver to the tab's overlay, mounting it first if needed (injecting the content script into tabs opened before install). */
  async function toOverlay(tabId: number, msg: ToOverlay) {
    const port = ports.get(tabId);
    if (port) {
      try {
        port.postMessage(msg);
        return;
      } catch {
        ports.delete(tabId);
      }
    }
    const q = pending.get(tabId) ?? [];
    q.push(msg);
    pending.set(tabId, q.slice(-4));
    try {
      await browser.tabs.sendMessage(tabId, { type: "mount" });
    } catch {
      try {
        await browser.scripting.executeScript({ target: { tabId }, files: ["content-scripts/content.js"] });
        await browser.tabs.sendMessage(tabId, { type: "mount" });
      } catch (e) {
        console.warn("[signlayer] cannot reach tab", tabId, e);
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
      return { ok: true, signs: h.signs, semantic: h.semantic, url: apiUrl };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), url: apiUrl };
    }
  }

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.removeAll().then(() =>
      browser.contextMenus.create({ id: "sl-sign", title: "Sign with SIGNLAYER", contexts: ["selection"] }),
    );
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "sl-sign" || tab?.id == null || !info.selectionText) return;
    toOverlay(tab.id, { type: "sign", text: info.selectionText, source: "selection" });
  });

  async function selectionIn(tabId: number) {
    const [r] = await browser.scripting.executeScript({ target: { tabId }, func: () => getSelection()?.toString() ?? "" });
    return (r?.result as string | undefined)?.trim() ?? "";
  }

  browser.commands.onCommand.addListener(async (command, tab) => {
    if (command !== "sign-selection") return;
    const tabId = tab?.id ?? (await activeTabId());
    if (tabId == null) return;
    const text = await selectionIn(tabId).catch(() => "");
    if (text) toOverlay(tabId, { type: "sign", text, source: "selection" });
  });

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as ToBackground;
    if (msg?.type === "health") {
      health().then(sendResponse);
      return true;
    }
    if (msg?.type === "sign" || msg?.type === "heard") {
      (async () => {
        const tabId = msg.target === "active" || !sender.tab ? await activeTabId() : sender.tab.id;
        if (tabId != null) await toOverlay(tabId, { type: msg.type, text: msg.text, source: msg.source });
        sendResponse({ ok: tabId != null });
      })();
      return true;
    }
  });

  // Test hook (puppeteer verification): sign text in a given tab, exactly like the context menu does.
  (globalThis as { __slSign?: unknown }).__slSign = (tabId: number, text: string, source: ToOverlay["source"] = "selection") =>
    toOverlay(tabId, { type: "sign", text, source });
});
