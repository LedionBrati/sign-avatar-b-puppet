import "@/lib/fonts";
import "./style.css";
import { browser, type Browser } from "wxt/browser";
import { captionFrame, createSignClient, ROUTES, type PlaylistItem, type SignResponse } from "@signlayer/core";
import { $, esc, ICON, mark, WORDMARK } from "@/lib/brand";
import { OVERLAY_PORT, type ChunkInfo, type StartReply, type ToBg, type ToOverlay } from "@/lib/messages";
import { getSettings, setSettings, SIZE_PX, type Size, type Source } from "@/lib/settings";
import { createWave } from "@/lib/wave";

// The floating card is the whole product (this page runs in an iframe inside the page's glass frame, float.ts):
//   Mic or Tab audio, captured and transcribed in the offscreen document ─► text messages here ─► phrases
//   ─► POST /api/sign (in parallel; applied in order; overtaken live results skipped) ─► playlist
//   ─► two stacked <video>s: the next clip preloads in the hidden one and crossfades in on its first painted frame.
// Like the web app's Live card: a phrase that can't be signed (the safety gate says caption_only / needs_confirmation)
// isn't played. No popup, no hint: the signer just stays still and the transcript still shows the words.

type Job = { res: SignResponse };
type View = "ready" | "starting" | "listening" | "signing" | "offline" | "error";
type Tone = "live" | "sign" | "off" | "idle";
const SRC_LABEL: Record<Source, string> = { mic: "Mic", tab: "Tab" };
const SIZES: Size[] = ["s", "m", "l"];

const params = new URLSearchParams(location.search);
const TAB = Number(params.get("tab")) || 0;
const card = $("card"), stageWrap = $("stageWrap");
const stage = $("stage"), cc = $("cc"), note = $("note");
const statusEl = $("pill"), dot = $("dot");
const go = $("go"), seg = $("seg"), sizeSeg = $("size"), gear = $("gear");
const vids = [$("v0") as HTMLVideoElement, $("v1") as HTMLVideoElement];
const still = $("still") as HTMLCanvasElement;
$("brand").innerHTML = mark() + WORDMARK;
gear.innerHTML = ICON.gear;
$("close").innerHTML = ICON.close;
const wave = createWave($("wv") as HTMLCanvasElement);

let s = await getSettings();
let client = createSignClient(s.apiUrl, { timeoutMs: 12_000 });

// ── Talking to the frame around us (float.ts, in the page) ──
const toFrame = (m: object) => parent.postMessage({ sl: 1, ...m }, "*"); // nothing private: sizes, drag deltas, state
let vpH = 10_000;
function fitStage() {
  const pad = 2 * (parseFloat(getComputedStyle(card).paddingLeft) || 10);
  const natural = (SIZE_PX[s.size] - pad) * 4 / 3;
  const other = card.offsetHeight - stageWrap.offsetHeight;
  const h = Math.max(150, Math.min(natural, vpH - 16 - other));
  stageWrap.style.height = `${Math.floor(h)}px`;
}
function applySize() {
  card.dataset.size = s.size;
  card.style.width = `${SIZE_PX[s.size]}px`;
  sizeSeg.dataset.size = s.size;
  sizeSeg.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.size === s.size)));
  fitStage();
}
new ResizeObserver(() => {
  const r = card.getBoundingClientRect();
  toFrame({ type: "layout", w: r.width, h: r.height });
  gripKey = ""; postGrip();
}).observe(card);
addEventListener("message", (e) => {
  if (e.source !== parent || (e.data as { sl?: number })?.sl !== 1) return;
  const m = e.data as { type: string; h?: number };
  if (m.type === "viewport" && m.h) { vpH = m.h; fitStage(); }
  if (m.type === "closing") stopListening();
});

// Drag by the header: the frame (float.ts) lays a transparent grip over the header's non-button part and drags
// the card in page coordinates. We tell it where that part is (up to the gear).
const grip = $("grip");
let gripKey = "";
function postGrip() {
  const g = grip.getBoundingClientRect(), b = gear.getBoundingClientRect();
  const r = { x: Math.round(g.left), y: Math.round(g.top), w: Math.round(b.left - 4 - g.left), h: Math.round(g.height) };
  const key = JSON.stringify(r);
  if (key !== gripKey) { gripKey = key; toFrame({ type: "grip", ...r }); }
}
new ResizeObserver(postGrip).observe(grip);

// Card size: S / M / L, in the gear menu.
function setSize(size: Size) {
  if (size === s.size) return;
  s.size = size;
  setSettings({ size });
  applySize();
  chunkKey = ""; renderCaptions();
}
sizeSeg.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-size]");
  if (b) setSize(b.dataset.size as Size);
});
sizeSeg.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const i = SIZES.indexOf(s.size) + (e.key === "ArrowRight" ? 1 : -1);
  setSize(SIZES[Math.min(SIZES.length - 1, Math.max(0, i))]!);
  sizeSeg.querySelector<HTMLButtonElement>(`[data-size="${s.size}"]`)?.focus();
});
$("close").addEventListener("click", () => { stopListening(); toFrame({ type: "close" }); });

// ── Listening state ──
let listening: "off" | "starting" | "on" = "off";
let errorText = ""; // capture / mic error: one small line under the transcript until the next Start
let hint = ""; // soft placeholder in the transcript
let isOffline = false, offlineMsg = "";

// ── Controls ──
function renderControls() {
  seg.dataset.src = s.source;
  seg.querySelectorAll<HTMLButtonElement>("[data-src]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.src === s.source)));
  const on = listening !== "off";
  go.setAttribute("aria-pressed", String(on));
  go.classList.toggle("starting", listening === "starting");
  $("goIc").innerHTML = on ? ICON.stop : ICON.play;
  const label = listening === "starting" ? "Starting…" : on ? "Stop" : s.source === "tab" ? "Listen to this tab" : "Start listening";
  go.setAttribute("aria-label", label);
  go.title = label;
}

seg.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-src]");
  if (!b || b.dataset.src === s.source) return;
  const was = listening !== "off";
  stopListening();
  s.source = b.dataset.src as Source;
  setSettings({ source: s.source });
  errorText = "";
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
go.addEventListener("click", () => (listening === "off" ? startListening() : stopListening()));

// Settings: a small gear opens an inline menu (card size, server URL).
const form = $("server") as HTMLFormElement, urlIn = $("apiUrl") as HTMLInputElement;
const setForm = (open: boolean) => {
  form.hidden = !open;
  gear.setAttribute("aria-expanded", String(open));
  fitStage();
};
function openServerForm() {
  setForm(true);
  urlIn.value = s.apiUrl;
  urlIn.focus();
  urlIn.select();
}
gear.addEventListener("click", () => (form.hidden ? openServerForm() : setForm(false)));
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = urlIn.value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/i.test(v)) { urlIn.setCustomValidity("http://host:port"); urlIn.reportValidity(); return; }
  urlIn.setCustomValidity("");
  s.apiUrl = v;
  setSettings({ apiUrl: v });
  client = createSignClient(v, { timeoutMs: 12_000 });
  neutralId = null; stillDone = false;
  setForm(false);
  checkHealth();
});

// ── Capture (runs in the offscreen document; the background brokers start/stop) ──
let port: Browser.runtime.Port | null = null;
let startToken = 0;
let micWaiting = false; // waiting for the one-time permission tab
/** While listening, a port to the background: it drops when this card goes away, and the capture stops. */
function ensurePort() {
  if (port) return;
  port = browser.runtime.connect({ name: `${OVERLAY_PORT}:${TAB}` });
  port.onDisconnect.addListener(() => { port = null; if (listening !== "off") ensurePort(); }); // the worker restarted
}
const toBg = <T>(m: ToBg) => browser.runtime.sendMessage(m) as Promise<T>;

async function startListening() {
  errorText = ""; hint = "";
  listening = "starting";
  renderControls();
  render();
  if (!TAB) return fail("This card lost track of its tab. Close it and click the Flux icon again.");
  ensurePort();
  const token = ++startToken;
  const r = await toBg<StartReply>({ target: "bg", type: "start", tabId: TAB, source: s.source, apiUrl: s.apiUrl })
    .catch((e): StartReply => ({ ok: false, error: `The extension didn't answer (${String(e).slice(0, 60)}). Try again.` }));
  if (token !== startToken) return; // stopped while starting
  if (r.ok) listening = "on";
  else if (r.error === "mic-denied") return openMicTab();
  else if (!r.error) listening = "off";
  else return fail(r.error);
  renderControls();
  render();
}

function stopListening() {
  const was = listening !== "off" || micWaiting;
  startToken++;
  micWaiting = false;
  listening = "off";
  hint = "";
  if (!job) heardText = "";
  if (was && TAB) toBg({ target: "bg", type: "stop", tabId: TAB }).catch(() => {});
  setLevel(0, false);
  renderControls();
  renderCaptions();
  render();
}

function fail(text: string) {
  startToken++;
  if (listening !== "off" && TAB) toBg({ target: "bg", type: "stop", tabId: TAB }).catch(() => {});
  listening = "off";
  errorText = text;
  setLevel(0, false);
  renderControls();
  render();
}

function openMicTab() {
  micWaiting = true;
  listening = "starting";
  hint = "Allow the microphone in the tab that just opened. Listening starts by itself.";
  toBg({ target: "bg", type: "open-mic", tabId: TAB }).catch(() => {});
  renderControls();
  render();
}

/** Diagnostics for scripts/verify.mjs: every chunk the server transcribed. */
const tabDebug = { chunks: [] as ChunkInfo[] };
(globalThis as { __slTab?: typeof tabDebug }).__slTab = tabDebug;

browser.runtime.onMessage.addListener((raw: unknown) => {
  const m = raw as ToOverlay | { type?: string; target?: string };
  // The permission tab tells us when the mic is allowed.
  if (m?.type === "mic-granted") {
    if (!micWaiting) return;
    micWaiting = false;
    hint = "";
    if (s.source === "mic") startListening();
    return;
  }
  if ((m as ToOverlay).target !== "overlay" || (m as ToOverlay).tabId !== TAB) return;
  const e = m as ToOverlay;
  if (e.type === "level") { if (listening === "on") setLevel(e.v, e.voiced); return; }
  if (listening === "off" && e.type !== "stopped") return;
  if (e.type === "chunk") { tabDebug.chunks.push(e.chunk); if (tabDebug.chunks.length > 50) tabDebug.chunks.shift(); }
  else if (e.type === "text") sign(e.text);
  else if (e.type === "hint") { hint = e.text; render(); }
  else if (e.type === "error") fail(e.text);
  else if (e.type === "stopped") { startToken++; listening = "off"; hint = e.reason; setLevel(0, false); renderControls(); render(); }
});

let lvlRaf = 0, lvl = 0, voiced = false;
function setLevel(x: number, v: boolean) {
  lvl = x;
  if (v !== voiced) { voiced = v; postState(); }
  wave.set(x, v, listening === "on");
  if (!lvlRaf) lvlRaf = requestAnimationFrame(() => {
    lvlRaf = 0;
    go.style.setProperty("--lvl", lvl.toFixed(3));
    dot.style.setProperty("--lvl", lvl.toFixed(3));
    stageWrap.style.setProperty("--lvl", lvl.toFixed(3));
  });
}
let stateKey = "";
function postState(tone = dot.dataset.tone ?? "idle") {
  const key = `${tone}|${voiced}`;
  if (key === stateKey) return;
  stateKey = key;
  toFrame({ type: "state", tone, voice: voiced });
}

// ── Player state ──
const jobs: Job[] = [];
let job: Job | null = null; // being signed
let shown: Job | null = null; // whose caption is on screen
let idx = -1;
let front = 0;
let heardText = "";
let pending = false;
/** The safety gate held this phrase back: it isn't signed (the transcript still shows it). */
const blocked = (j: Job | null) => !!j && !!j.res.safety && j.res.safety.status !== "fully_supported";

function view(): View {
  if (isOffline) return "offline";
  if (errorText) return "error";
  if (job) return "signing";
  if (listening === "starting") return "starting";
  if (listening === "on") return "listening";
  return "ready";
}

// ── Status: a tiny coloured dot by the wordmark (the label is for screen readers) ──
const LABEL: Record<View, string> = { ready: "Ready", starting: "Starting", listening: "Listening", signing: "Signing", offline: "Offline", error: "Off" };
function setStatus(tone: Tone, label: string) {
  postState(tone);
  dot.dataset.tone = tone;
  if (statusEl.textContent !== label) statusEl.textContent = label;
}

function render() {
  const v = view();
  stage.dataset.state = v;
  document.body.dataset.state = v;
  document.body.dataset.listening = listening;
  const tone: Tone = v === "signing" ? "sign" : v === "listening" ? "live" : v === "offline" || v === "error" ? "off" : "idle";
  setStatus(tone, v === "listening" ? `${LABEL[v]} to ${SRC_LABEL[s.source]}` : LABEL[v]);
  renderNote(v);
  if (v !== "signing") showNeutral();
}

// Real problems that need the user (server unreachable, capture off): one small, clean line under the transcript.
let noteKey = "";
function renderNote(v: View) {
  const html = v === "offline"
    ? `<span>${offlineMsg}</span><button type="button" data-act="server">Set server</button><button type="button" data-act="retry">Retry</button>`
    : v === "error" ? `<span>${esc(errorText)}</span>` : "";
  if (html !== noteKey) {
    noteKey = html;
    note.innerHTML = html;
    fitStage();
  }
  cc.dataset.empty = hint ? hint
    : v === "listening" ? (s.source === "tab" ? "Listening to this tab…" : "Listening… speak near your computer.")
    : v === "starting" ? ""
    : s.source === "tab" ? "Play something in this tab, then press Start."
    : "Press Start and speak.";
}

note.addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]")?.dataset.act;
  if (act === "retry") checkHealth();
  if (act === "server") openServerForm();
});

// ── Gapless playlist player with a crossfade ──
function load(v: HTMLVideoElement, url: string) {
  if (v.dataset.url === url) return;
  v.dataset.url = url;
  v.src = url;
  v.load();
}

function peek(): PlaylistItem | undefined {
  if (job && idx + 1 < job.res.playlist.length) return job.res.playlist[idx + 1];
  return jobs.find((j) => j.res.playlist.length)?.res.playlist[0];
}

/** Seconds of signing still queued (drives catch-up speed so the signer stays near real time). */
function backlog() {
  let t = 0;
  if (job) job.res.playlist.slice(idx + 1).forEach((p) => (t += p.duration_s));
  jobs.forEach((j) => j.res.playlist.forEach((p) => (t += p.duration_s)));
  return t;
}
const rate = () => { const b = backlog(); return b > 6 ? 1.3 : b > 3 ? 1.15 : 1; };

let swapToken = 0;
let swapping = false; // the back video is starting: don't load anything else into it until it is on screen
let holdTimer = 0; // a phrase that can't be signed stays readable in the transcript this long before the next one plays
function advance() {
  clearTimeout(holdTimer);
  holdTimer = 0;
  if (job && idx + 1 < job.res.playlist.length) idx++;
  else {
    job = null;
    idx = -1;
    while (jobs.length) {
      const j = jobs.shift()!;
      shown = j;
      heardText = "";
      if (blocked(j)) {
        // Its turn came (after the phrase before it finished signing): nothing plays, the signer stays still on its
        // last frame, and the words stay readable in the transcript for a moment.
        renderCaptions();
        render();
        holdTimer = window.setTimeout(() => { holdTimer = 0; if (!job && jobs.length) advance(); }, Math.min(3000, 1200 + j.res.words.length * 150));
        return;
      }
      if (j.res.playlist.length) { job = j; idx = 0; break; }
    }
  }
  if (!job) { renderCaptions(); render(); return; }
  const item = job.res.playlist[idx]!;
  const back = vids[1 - front]!, cur = vids[front]!;
  load(back, item.url);
  if (back.currentTime > 0.01) back.currentTime = 0;
  back.playbackRate = rate();
  let swapped = false;
  swapping = true;
  const token = ++swapToken;
  // On the incoming clip's first painted frame: fade it in on top; the outgoing clip stays visible underneath
  // until the fade is done, then steps back and preloads whatever comes next.
  const swap = () => {
    if (swapped) return;
    swapped = true;
    cur.classList.remove("top");
    back.classList.add("top", "on");
    front = 1 - front;
    setTimeout(() => {
      if (token !== swapToken) return;
      swapping = false;
      cur.classList.remove("on");
      cur.pause();
      const next = peek();
      if (next) load(cur, next.url);
    }, 140);
  };
  back.requestVideoFrameCallback?.(() => swap());
  back.addEventListener("playing", () => setTimeout(swap, 40), { once: true });
  back.play().catch((e) => {
    console.warn("[signlayer] play failed", item.url, e);
    swap();
    setTimeout(advance, 0);
  });
  render();
  renderCaptions();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (job) { const rest = jobs.slice(); clearVideo(); jobs.push(...rest.slice(-1)); renderCaptions(); render(); }
  } else if (!job && !holdTimer && jobs.length) advance();
});

vids.forEach((v) => {
  v.addEventListener("ended", () => v === vids[front] && job && advance());
  v.addEventListener("error", () => {
    if (v === vids[front] && job && v.getAttribute("src")) { console.warn("[signlayer] clip failed", v.src); advance(); }
  });
});

function enqueue(j: Job) {
  // In a background tab (the user switched away from the call; listening goes on) Chrome may pause muted video:
  // keep just the newest phrase and sign it when the tab is visible again.
  if (document.hidden) { jobs.length = 0; jobs.push(j); return; }
  // Live speech: never fall far behind. Drop whole not-yet-started phrases beyond ~8 s of backlog.
  while (jobs.length && backlog() > 8) jobs.shift();
  jobs.push(j);
  if (!job && !holdTimer) advance();
  else if (!swapping) {
    const next = peek();
    if (next) load(vids[1 - front]!, next.url);
  }
}

function clearVideo() {
  jobs.length = 0;
  job = null;
  idx = -1;
  stopVideo();
}
/** Never a stale clip under a caption: both videos stop and drop their source. */
function stopVideo() {
  front = 0;
  swapToken++;
  swapping = false;
  vids.forEach((v) => { v.pause(); v.removeAttribute("src"); delete v.dataset.url; v.load(); v.classList.remove("on", "top"); });
}

// ── Transcript: words blur in, the word being signed is highlighted ──
const chunkSize = () => (s.size === "s" ? 5 : s.size === "m" ? 6 : 8);
let chunkKey = "";
function renderCaptions() {
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
  const j = job ?? shown;
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
  let now: HTMLElement | null = null;
  cc.querySelectorAll<HTMLElement>(".w").forEach((el) => {
    const st = states[Number(el.dataset.i)] ?? "upcoming";
    el.classList.toggle("heard", st === "heard");
    el.classList.toggle("signed", st === "signed");
    el.classList.toggle("now", st === "now");
    if (st === "now") now = el;
  });
  const hl = cc.querySelector<HTMLElement>(".hl")!;
  const target = now as HTMLElement | null;
  if (target) {
    hl.style.transform = `translate(${target.offsetLeft - 4}px, ${target.offsetTop}px)`;
    hl.style.width = `${target.offsetWidth + 8}px`;
    hl.style.height = `${target.offsetHeight}px`;
    hl.classList.add("show");
  } else hl.classList.remove("show");
}

// ── Requests: start at once, apply in order, skip results that were overtaken (stay near real time) ──
const clean = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 500);
let seq = 0;
let chain: Promise<void> = Promise.resolve();
/** Diagnostics for scripts/verify.mjs. */
const dbg = { phrases: [] as { text: string; status: string; glosses: string }[], sign: (t: string) => sign(t) };
(globalThis as { __sl?: typeof dbg }).__sl = dbg;

function sign(text: string) {
  const t = clean(text);
  if (!t) return;
  const id = ++seq;
  const p = client.sign({ text: t });
  p.catch(() => {});
  if (!job && !holdTimer) {
    heardText = t;
    pending = true;
    if (blocked(shown)) shown = null; // the old blocked caption gives way to the new phrase
    renderCaptions();
    render();
  }
  chain = chain.then(async () => {
    let res: SignResponse;
    try {
      res = await p;
    } catch (e) {
      if (id === seq) { pending = false; clearVideo(); offline(e); renderCaptions(); }
      return;
    }
    if (id === seq) pending = false;
    if (isOffline) { isOffline = false; render(); }
    dbg.phrases.push({ text: t, status: res.safety?.status ?? "?", glosses: res.playlist.map((x) => x.gloss).join(" ") });
    if (id < seq - 2) return; // overtaken while waiting: keep up with the speech
    // Phrases that can't be signed queue in order like the rest (they just don't play).
    enqueue({ res });
  });
}

function offline(e: unknown) {
  let host = s.apiUrl;
  try { host = new URL(s.apiUrl).host; } catch { /* keep */ }
  offlineMsg = `Can't reach <b>${esc(host)}</b>.`;
  console.warn("[signlayer]", e);
  isOffline = true;
  render();
}

// While offline, keep checking quietly: the card comes back by itself once the server is up.
setInterval(() => { if (isOffline && !document.hidden) checkHealth(); }, 10_000);

async function checkHealth() {
  try {
    await client.health();
    if (isOffline) { isOffline = false; render(); }
    showNeutral();
  } catch (e) {
    offline(e);
  }
}

/** Idle: the signer waits in the neutral pose (first frame of a clip), also painted into the still behind the videos. */
let neutralId: string | null = null;
let stillDone = false;
async function showNeutral() {
  if (job || vids[front]!.dataset.url) return;
  try {
    neutralId ??= (await client.vocab()).signs[0]?.motion_id ?? null;
    if (!neutralId || job || vids[front]!.dataset.url) return;
    const v = vids[front]!;
    load(v, `${client.base}${ROUTES.clips}${neutralId}.mp4`);
    v.addEventListener("loadeddata", () => {
      paintStill(v);
      if (!job) v.classList.add("on");
    }, { once: true });
  } catch {
    /* idle tile keeps its pastel glass */
  }
}
function paintStill(v: HTMLVideoElement) {
  if (stillDone || !v.videoWidth) return;
  still.width = v.videoWidth >> 1;
  still.height = v.videoHeight >> 1;
  try {
    still.getContext("2d")!.drawImage(v, 0, 0, still.width, still.height);
    stillDone = true;
  } catch { /* cross-origin without CORS: the tile keeps its studio backdrop */ }
}

applySize();
renderControls();
render();
checkHealth();
// Opened by a toolbar click while Tab audio was running on another tab: listening moves here.
if (params.get("autostart") === "tab") { s.source = "tab"; renderControls(); startListening(); }
