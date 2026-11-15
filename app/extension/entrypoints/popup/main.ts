import "./style.css";
import { browser } from "wxt/browser";
import type { HealthResult, TabAudioStatus, ToBackground } from "@/lib/messages";
import { getSettings, onSettings, setSettings, SOURCES, type Settings, type Size, type Source } from "@/lib/settings";
import { $, esc, mark, WORDMARK } from "@/lib/brand";
import { ICON, SOURCE_ICON } from "@/lib/icons";

document.querySelectorAll(".brand").forEach((el) => (el.innerHTML = mark() + WORDMARK));
document.querySelectorAll(".brand-mark").forEach((el) => (el.innerHTML = mark()));
document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => (el.innerHTML = SOURCE_ICON[el.dataset.icon as Source] ?? ""));
const send = <T>(m: ToBackground) => browser.runtime.sendMessage(m) as Promise<T>;

let s: Settings = await getSettings();
let health: HealthResult | null = null;
let tab: TabAudioStatus = { tabId: null, state: "off" };
const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });

// ── First run ──
function showScreen() {
  $("onboard").hidden = s.onboarded;
  $("main").hidden = !s.onboarded;
}
$("start").addEventListener("click", async () => {
  await setSettings({ onboarded: true, enabled: true });
  send({ type: "mount-active" }).catch(() => {});
});

// ── Main ──
let site = "This page";
try {
  const u = activeTab?.url ? new URL(activeTab.url) : null;
  if (u && /^https?:$/.test(u.protocol)) site = u.hostname.replace(/^www\./, "");
} catch { /* keep */ }
$("site").textContent = site;

/** One quiet line under the segmented control: what this source does, or what it needs right now. */
const HINT: Record<Source, () => string> = {
  captions: () => "Follows the video's transcript or captions, in time with it.",
  tab: () => {
    if (health?.ok && health.transcribe === "off") return `<span class="bad">Speech-to-text is off on the server.</span>`;
    if (tab.state === "listening" && tab.tabId === activeTab?.id) return `<span class="ok">Listening to this tab.</span> Speech shows up in a second or two.`;
    if (tab.state === "starting") return "Starting…";
    if (tab.state === "error") return `<span class="bad">${esc(tab.detail ?? "Tab audio stopped")}</span>`;
    if (tab.state === "listening") return "Listening to another tab.";
    return "Whatever this tab plays: calls, podcasts, any video.";
  },
  mic: () => "Speech around you, recognised by Chrome in the side panel.",
  selection: () => "Select text, then right-click › <b>Sign with SIGNLAYER</b>.",
};

function render() {
  showScreen();
  $("sw").setAttribute("aria-checked", String(s.enabled));
  $("hero").classList.toggle("off", !s.enabled);
  $("ccsw").setAttribute("aria-checked", String(s.captions));
  document.querySelectorAll<HTMLButtonElement>("#srcseg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === s.source)));
  $("srcseg").style.setProperty("--i", String(SOURCES.indexOf(s.source)));
  document.querySelectorAll<HTMLButtonElement>('[data-seg="size"] button').forEach((b) => {
    b.classList.toggle("on", b.dataset.v === s.size);
    b.setAttribute("aria-checked", String(b.dataset.v === s.size));
  });
  $("hint").innerHTML = HINT[s.source]();
  const act = $("act") as HTMLButtonElement;
  const here = tab.tabId === activeTab?.id && (tab.state === "listening" || tab.state === "starting");
  act.hidden = !(s.source === "tab" || s.source === "mic");
  act.classList.toggle("ghost", s.source === "tab" && here);
  act.innerHTML = s.source === "mic" ? `${ICON.mic}Open the mic panel` : here ? `${ICON.pause}Stop tab audio` : `${ICON.tab}Start tab audio`;
  const input = $("apiUrl") as HTMLInputElement;
  if (document.activeElement !== input) input.value = s.apiUrl;
}

async function toggleEnabled() {
  const on = !s.enabled;
  s.enabled = on;
  render();
  await setSettings({ enabled: on });
  if (on) send({ type: "mount-active" }).catch(() => {});
}
$("sw").addEventListener("click", toggleEnabled);
// The whole row is the hit target, like a settings cell.
$("hero").addEventListener("click", (e) => { if (!(e.target as HTMLElement).closest("#sw")) toggleEnabled(); });
$("ccsw").addEventListener("click", () => setSettings({ captions: !s.captions }));
document.querySelectorAll<HTMLButtonElement>('[data-seg="size"] button').forEach((b) => b.addEventListener("click", () => setSettings({ size: b.dataset.v as Size })));

$("srcseg").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!b) return;
  const v = b.dataset.v as Source;
  s.source = v;
  render(); // the thumb moves on the click, not after the storage round trip
  await setSettings({ source: v, enabled: true });
  // This click is the user gesture tabCapture needs: start tab audio right away.
  if (v === "tab") startTab();
  else if (v !== "captions") send({ type: "mount-active" }).catch(() => {});
});
// Arrow keys move along the segmented control (radio group).
$("srcseg").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  e.preventDefault();
  const i = (SOURCES.indexOf(s.source) + (e.key === "ArrowRight" ? 1 : SOURCES.length - 1)) % SOURCES.length;
  document.querySelector<HTMLButtonElement>(`#srcseg [data-v="${SOURCES[i]}"]`)?.focus();
});

async function startTab() {
  tab = { tabId: activeTab?.id ?? null, state: "starting" };
  render();
  const r = await send<{ ok: boolean; error?: string }>({ type: "tab-audio", on: true, tabId: activeTab?.id }).catch((e) => ({ ok: false, error: String(e) }));
  if (!r.ok) tab = { tabId: activeTab?.id ?? null, state: "error", detail: r.error };
  pollTab();
}

$("act").addEventListener("click", async () => {
  if (s.source === "mic") {
    const win = await browser.windows.getCurrent();
    if (win.id != null) await browser.sidePanel.open({ windowId: win.id });
    window.close();
    return;
  }
  const here = tab.tabId === activeTab?.id && (tab.state === "listening" || tab.state === "starting");
  if (here) {
    await send({ type: "tab-audio", on: false });
    pollTab();
  } else startTab();
});

$("apiForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = ($("apiUrl") as HTMLInputElement).value.trim().replace(/\/$/, "");
  if (url) setSettings({ apiUrl: url }).then(checkHealth);
});

async function checkHealth() {
  const pill = $("status"), text = $("statusText"), st = $("apiStatus");
  pill.className = "status";
  health = await send<HealthResult>({ type: "health" });
  pill.classList.add(health.ok ? "ok" : "bad");
  text.textContent = health.ok ? `${health.signs} signs` : "Offline";
  pill.title = health.ok ? `Connected to ${health.url}` : `Can't reach ${health.url}`;
  st.innerHTML = health.ok
    ? `<span class="ok">Connected</span> · speech-to-text ${esc(health.transcribe ?? "off")} · agent ${esc(health.agent ?? "off")}`
    : `<span class="bad">Can't reach ${esc(health.url)}</span>. Start it with <b>node app/server/index.mjs</b>`;
  if (!health.ok) ($("server") as HTMLDetailsElement).open = true;
  render();
}

let pollTimer = 0;
async function pollTab() {
  clearTimeout(pollTimer);
  tab = await send<TabAudioStatus>({ type: "tab-audio-status" }).catch(() => tab);
  render();
  if (s.source === "tab") pollTimer = window.setTimeout(pollTab, 800);
}

onSettings((patch) => {
  s = { ...s, ...patch };
  render();
  if (patch.source === "tab") pollTab();
});
render();
checkHealth();
pollTab();
