import "./style.css";
import { browser } from "wxt/browser";
import type { HealthResult } from "@/lib/messages";
import { getSettings, onSettings, setSettings, type Settings, type Size, type Source } from "@/lib/settings";
import { $, esc, MARK, WORDMARK } from "@/lib/brand";

$("brand").innerHTML = MARK + WORDMARK;
let s: Settings = await getSettings();

const HINTS: Record<Source, string> = {
  captions: "Play a YouTube video with <b>CC</b> on. The signer signs each caption line.",
  mic: "Speech from your microphone, recognised on this device. Runs in the side panel.",
  selection: "Select text on any page, then right-click › <b>Sign with SIGNLAYER</b> or press <b>Alt+Shift+S</b>.",
};

function render() {
  $("sw").setAttribute("aria-checked", String(s.enabled));
  const val: Record<string, string> = { source: s.source, size: s.size, captions: s.captions ? "on" : "off" };
  document.querySelectorAll<HTMLElement>("[data-seg]").forEach((seg) =>
    seg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.v === val[seg.dataset.seg!])),
  );
  $("hint").innerHTML = HINTS[s.source];
  $("micBtn").hidden = s.source !== "mic";
  const input = $("apiUrl") as HTMLInputElement;
  if (document.activeElement !== input) input.value = s.apiUrl;
}

$("sw").addEventListener("click", () => setSettings({ enabled: !s.enabled }));
document.querySelectorAll<HTMLElement>("[data-seg]").forEach((seg) =>
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b || b.disabled) return;
    const v = b.dataset.v!;
    const k = seg.dataset.seg;
    if (k === "source") setSettings({ source: v as Source });
    if (k === "size") setSettings({ size: v as Size });
    if (k === "captions") setSettings({ captions: v === "on" });
  }),
);

$("micBtn").addEventListener("click", async () => {
  const win = await browser.windows.getCurrent();
  if (win.id != null) await browser.sidePanel.open({ windowId: win.id });
  window.close();
});

$("apiForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = ($("apiUrl") as HTMLInputElement).value.trim().replace(/\/$/, "");
  if (url) setSettings({ apiUrl: url }).then(checkHealth);
});

async function checkHealth() {
  const pill = $("plive"), text = $("pliveText"), st = $("apiStatus");
  text.textContent = "Checking";
  const h = (await browser.runtime.sendMessage({ type: "health" })) as HealthResult;
  pill.classList.toggle("off", false);
  pill.classList.toggle("err", !h.ok);
  text.textContent = h.ok ? "Ready" : "Offline";
  st.innerHTML = h.ok
    ? `<span class="ok">Connected</span> · ${h.signs} signs · semantic ${esc(h.semantic)}`
    : `<span class="bad">Can't reach ${esc(h.url)}</span>. Start it with <b>node app/server/index.mjs</b>`;
}

onSettings((patch) => {
  s = { ...s, ...patch };
  render();
});
render();
checkHealth();
