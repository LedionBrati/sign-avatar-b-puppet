import "./style.css";
import { browser } from "wxt/browser";
import { captionFrame, createSignClient, ROUTES, type PlaylistItem, type SignResponse } from "@signlayer/core";
import type { FromOverlay, Origin, SourceState, TabAudioState, ToBackground, ToFrame, ToOverlay } from "@/lib/messages";
import { getSettings, onSettings, setSettings, SOURCE_LABEL, SOURCES, type Settings, type Size, type Source } from "@/lib/settings";
import { $, esc } from "@/lib/brand";
import { ICON, SOURCE_ICON } from "@/lib/icons";

// The signer: an extension page inside an iframe the content script injects. One glass card:
//  - Stage: two stacked <video>s. The next clip preloads in the hidden one and crossfades in on top (100 ms) on its
//    first painted frame, so there is never a black frame. Behind both sits a still of the neutral pose.
//  - Island: the status capsule; its width springs to each label.
//  - Sheet: live captions, fixed two-line height; words blur in, the word being signed is softly highlighted.
//  - Requests start as soon as a phrase arrives (and the next transcript line is fetched ahead); results are applied
//    in order, and live sources skip results that were overtaken, so the signer stays near real time.
//  - Safety gate (docs/semantic-safety.md): caption_only / needs_confirmation stop and clear the player at once; the
//    still blurs back and the exact caption comes forward, with the reason underneath. needs_confirmation plays only
//    after an explicit "Show signs" click.

type Job = { res: SignResponse; source: Source; confirmed?: boolean };
type View = "listening" | "signing" | "caption_only" | "confirm" | "offline" | "paused" | "ad" | "need-cc" | "tab-error";
type Tone = "live" | "sign" | "warn" | "off" | "idle";
/** Views where the signer can't sign right now. */
const BLOCKED = new Set<View>(["caption_only", "confirm", "offline", "tab-error"]);

const card = $("card"), cc = $("cc"), island = $("pill"), islandIn = $("islandIn"), dot = $("dot");
const focusText = $("focusText"), noteText = $("noteText"), noteActions = $("noteActions");
const pillState = $("pillState"), pillSub = $("pillSub");
const srcBtn = $("srcBtn"), srcMenu = $("srcMenu"), ccBtn = $("ccBtn"), sizeBtn = $("sizeBtn");
const vids = [$("v0") as HTMLVideoElement, $("v1") as HTMLVideoElement];
const still = $("still") as HTMLCanvasElement;
ccBtn.innerHTML = ICON.subtitles;
sizeBtn.innerHTML = ICON.size;
$("closeBtn").innerHTML = ICON.close;

const post = (m: FromOverlay) => parent.postMessage(m, "*");
const send = (m: ToBackground) => browser.runtime.sendMessage(m).catch(() => undefined);
let s: Settings = await getSettings();
let client = createSignClient(s.apiUrl, { timeoutMs: 12_000 });
const originOf = (src: Source): Origin => (src === "tab" ? "tab" : src === "mic" ? "mic" : src === "selection" ? "selection" : "captions");
let origin: Origin = originOf(s.source);
let srcState: SourceState = { kind: "idle" };
let tabState: TabAudioState = "off";
let tabDetail = "";
let offlineMsg = "";
let isOffline = false;
let phrases = 0; // phrases received since load (hides the first-run hint)
let mediaRate = 1; // the page video's playbackRate (YouTube 1.25x / 1.5x ...)

// ── Theme: the content script reads the page's own background and tells us (light / dark, fullscreen) ──
addEventListener("message", (e: MessageEvent) => {
  if (e.source !== parent) return;
  const m = e.data as ToFrame;
  if (m?.sl !== 1 || m.type !== "theme") return;
  document.body.dataset.theme = m.dark ? "dark" : "light";
  document.body.classList.toggle("fs", !!m.fs);
});

// ── Settings + controls ──
const SIZES: Size[] = ["s", "m", "l"];
const SIZE_NAME: Record<Size, string> = { s: "Small", m: "Medium", l: "Large" };
const nextSize = (z: Size): Size => SIZES[(SIZES.indexOf(z) + 1) % SIZES.length]!;
function applySettings() {
  document.body.dataset.size = s.size;
  sizeBtn.dataset.size = s.size;
  sizeBtn.setAttribute("aria-label", `Size: ${SIZE_NAME[s.size]}. Switch to ${SIZE_NAME[nextSize(s.size)]}`);
  sizeBtn.title = `Size: ${SIZE_NAME[s.size]}`;
  card.classList.toggle("nocc", !s.captions);
  ccBtn.setAttribute("aria-pressed", String(s.captions));
  ccBtn.title = s.captions ? "Hide captions" : "Show captions";
  srcBtn.innerHTML = SOURCE_ICON[s.source];
  srcBtn.title = `Listening to: ${SOURCE_LABEL[s.source]}`;
  client = createSignClient(s.apiUrl, { timeoutMs: 12_000 });
  chunkKey = "";
  render();
  renderCaptions();
}
onSettings((patch) => {
  s = { ...s, ...patch };
  if (patch.source) {
    origin = originOf(patch.source);
    if (patch.source !== "captions") srcState = { kind: "idle" };
  }
  applySettings();
  if ("apiUrl" in patch) checkHealth();
});
sizeBtn.addEventListener("click", () => setSettings({ size: nextSize(s.size) }));
ccBtn.addEventListener("click", () => setSettings({ captions: !s.captions }));
$("closeBtn").addEventListener("click", () => post({ sl: 1, type: "close" }));

// Source menu
srcMenu.innerHTML = SOURCES.map((src) =>
  `<button role="menuitemradio" data-src="${src}">${SOURCE_ICON[src]}<span class="lbl">${SOURCE_LABEL[src]}</span><span class="chk">${ICON.check}</span></button>`).join("");
function toggleMenu(open: boolean = srcMenu.hidden === true) {
  srcMenu.hidden = !open;
  srcBtn.setAttribute("aria-expanded", String(open));
  card.classList.toggle("bar-on", open);
  srcMenu.querySelectorAll<HTMLButtonElement>("[data-src]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.src === s.source)));
  if (open) srcMenu.querySelector<HTMLButtonElement>(`[data-src="${s.source}"]`)?.focus();
}
srcBtn.addEventListener("click", (e) => {
  const closing = !srcMenu.hidden;
  toggleMenu();
  // Closed with the mouse: let go of focus too, so the toolbar folds back into the island when the pointer leaves.
  if (closing && e.detail > 0) srcBtn.blur();
});
srcMenu.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-src]");
  if (!b) return;
  const src = b.dataset.src as Source;
  toggleMenu(false);
  if (e.detail > 0) (document.activeElement as HTMLElement | null)?.blur();
  await setSettings({ source: src, enabled: true });
  if (src === "tab") send({ type: "tab-audio", on: true });
  if (src === "mic") openMicPanel();
});
srcMenu.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...srcMenu.querySelectorAll<HTMLButtonElement>("[data-src]")];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
});
addEventListener("keydown", (e) => { if (e.key === "Escape" && !srcMenu.hidden) { toggleMenu(false); srcBtn.focus(); } });
document.addEventListener("pointerdown", (e) => { if (!srcMenu.hidden && !(e.target as HTMLElement).closest("#srcMenu, #srcBtn")) toggleMenu(false); });

async function openMicPanel() {
  try {
    const tab = await browser.tabs.getCurrent();
    if (tab?.id != null) await browser.sidePanel.open({ tabId: tab.id });
  } catch {
    tabDetail = "Open the mic panel from the SIGNLAYER menu";
  }
}

// ── Height -> content script (the iframe follows the card) ──
new ResizeObserver(() => post({ sl: 1, type: "height", h: card.offsetHeight })).observe(card);

// ── Drag (screen coordinates: the iframe moves under the pointer; the content script adds momentum + corner snap).
//    Starts after 4 px, so clicks stay clicks. The whole card is the handle. ──
let drag: { x: number; y: number; cx: number; cy: number; on: boolean } | null = null;
card.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, .menu, .focus-actions")) return;
  drag = { x: e.screenX, y: e.screenY, cx: e.clientX, cy: e.clientY, on: false };
  card.setPointerCapture(e.pointerId);
});
card.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.on) {
    if (Math.hypot(dx, dy) < 4) return;
    drag.on = true;
    card.classList.add("dragging");
    post({ sl: 1, type: "dragstart", x: drag.cx, y: drag.cy });
  }
  post({ sl: 1, type: "drag", dx, dy });
});
const endDrag = () => {
  if (drag?.on) {
    card.classList.remove("dragging");
    post({ sl: 1, type: "dragend" });
  }
  drag = null;
};
card.addEventListener("pointerup", endDrag);
card.addEventListener("pointercancel", endDrag);
// Touch / pen: a tap shows the controls for a few seconds.
let barTimer = 0;
card.addEventListener("pointerup", (e) => {
  if (e.pointerType === "mouse") return;
  card.classList.add("bar-on");
  clearTimeout(barTimer);
  barTimer = window.setTimeout(() => srcMenu.hidden && card.classList.remove("bar-on"), 4000);
});

// ── Player state ──
const jobs: Job[] = [];
let job: Job | null = null; // being signed
let shown: Job | null = null; // whose caption is on screen
let idx = -1;
let front = 0;
let heardText = "";
let pending = false;

const blocked = (j: Job | null) => !!j && !j.confirmed && !!j.res.safety && j.res.safety.status !== "fully_supported";

function view(): View {
  if (isOffline) return "offline";
  if (s.source === "tab" && tabState === "error") return "tab-error";
  if (job) return srcState.kind === "paused" && job.source === "captions" ? "paused" : "signing";
  if (blocked(shown)) return shown!.res.safety!.status === "needs_confirmation" ? "confirm" : "caption_only";
  if (srcState.kind === "ad") return "ad";
  if (srcState.kind === "paused") return "paused";
  if (srcState.kind === "need-cc") return "need-cc";
  return "listening";
}

const ORIGIN_LABEL: Record<Origin, string> = { transcript: "Transcript", captions: "Captions", texttrack: "Captions", tab: "Tab audio", mic: "Mic", selection: "Text" };
const quoteList = (xs: string[]) => {
  const u = [...new Set(xs.map((x) => x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, "")).filter(Boolean))];
  const head = u.slice(0, 3).map((x) => `<q>${esc(x)}</q>`).join(", ");
  return u.length > 3 ? `${head} +${u.length - 3}` : head;
};

/** Plain-language reason for a blocked phrase (Alex's rule: say why, never just go quiet). */
function reasonLine(res: SignResponse) {
  const r = res.safety!.reasons;
  const has = (code: string) => r.some((x) => x.code === code);
  const toks = (...codes: string[]) => r.filter((x) => codes.includes(x.code)).flatMap((x) => x.tokens);
  if (has("unrepresented_negation")) return `${quoteList(toks("unrepresented_negation"))} can't be signed reliably yet`;
  if (has("numerical_meaning")) return "Numbers and times stay as captions for now";
  if (has("missing_fingerspelling")) return `Names like ${quoteList(toks("missing_fingerspelling"))} need fingerspelling, not available yet`;
  const missing = toks("unsupported_token", "missing_clip", "dropped_meaning");
  if (missing.length) return `No sign yet for ${quoteList(missing)}`;
  return esc(res.safety!.next_actions[0] ?? "This phrase can't be signed yet");
}

// ── Island: the status capsule morphs (width springs, label blurs in) ──
let islandKey = "";
function setIsland(tone: Tone, state: string, sub = "", subGloss = false) {
  const key = `${tone}|${state}|${sub}`;
  if (key === islandKey) return;
  const first = !islandKey;
  islandKey = key;
  island.dataset.tone = tone;
  const from = island.getBoundingClientRect().width;
  pillState.textContent = state;
  pillSub.textContent = sub ? ` · ${sub}` : "";
  pillSub.className = subGloss ? "gl" : "";
  pillSub.hidden = !sub;
  // Natural width of the new label, then spring from the old width to it.
  island.style.width = "auto";
  const to = islandIn.getBoundingClientRect().width;
  if (!first && from > 0) {
    island.style.width = `${from}px`;
    void island.offsetWidth;
  }
  island.style.width = `${Math.ceil(to)}px`;
  if (!first) {
    islandIn.classList.remove("morph");
    void islandIn.offsetWidth;
    islandIn.classList.add("morph");
  }
}

function render() {
  const v = view();
  card.dataset.state = v;
  card.classList.toggle("blocked", BLOCKED.has(v));
  const cur = job?.res.playlist[idx];
  if (v === "signing") setIsland("sign", "Signing", cur?.gloss ?? "", true);
  else if (v === "caption_only") setIsland("warn", "Can't sign yet", origin === "tab" || origin === "mic" ? ORIGIN_LABEL[origin] : "");
  else if (v === "confirm") setIsland("warn", "Confirm signs?");
  else if (v === "offline") setIsland("off", "Offline");
  else if (v === "tab-error") setIsland("off", "Tab audio off");
  else if (v === "paused") setIsland("idle", "Paused");
  else if (v === "ad") setIsland("idle", "Ad playing");
  else if (v === "need-cc") setIsland("idle", "Turn on CC");
  else setIsland("live", "Listening", ORIGIN_LABEL[origin]);
  renderFocus(v);
  syncPlayback();
  if (v === "listening" || v === "paused" || v === "ad" || v === "need-cc") showNeutral();
}

/** The large caption over the blurred still, plus the reason (sheet) and actions. */
let focusKey = "";
function setFocus(html: string, note = "", actions = "", len = 0) {
  const key = `${html}|${actions}`;
  if (key !== focusKey) {
    focusKey = key;
    focusText.innerHTML = html;
    focusText.dataset.len = len > 22 ? "l" : len > 11 ? "m" : "s";
    noteActions.innerHTML = actions;
    focusText.classList.toggle("overflow", focusText.scrollHeight > focusText.clientHeight + 2);
  }
  noteText.innerHTML = note;
}
const words = (text: string, bad?: Set<string>) =>
  text.split(/\s+/).filter(Boolean).map((w, k) => `<span class="w${bad?.has(bare(w)) ? " nosign" : ""}" style="--k:${k}">${esc(w)}</span>`).join(" ");

function renderFocus(v: View) {
  const res = shown?.res;
  if (v === "caption_only" && res) {
    const caption = res.safety!.caption;
    const bad = new Set([...res.unsupported, ...(res.fingerspell ?? []), ...res.safety!.reasons.flatMap((r) => r.tokens)].map(bare));
    return setFocus(words(caption, bad), reasonLine(res), "", caption.split(/\s+/).length);
  }
  if (v === "confirm" && res) {
    const amb = res.safety!.reasons.filter((r) => r.code === "ambiguous_sense").flatMap((r) => r.tokens);
    const glosses = confirmPlaylist(res)?.map((p) => p.gloss).join(" · ");
    const why = amb.length ? `${quoteList(amb)} could mean more than one thing` : "These signs are a paraphrase. Show them?";
    const caption = res.safety!.caption;
    const actions = (glosses ? `<button class="primary" data-act="confirm">${ICON.play}Show signs</button>` : "") + `<button data-act="skip">Skip</button>`;
    return setFocus(words(caption) + (glosses ? `<span class="gl">${esc(glosses)}</span>` : ""), why, actions, caption.split(/\s+/).length + 4);
  }
  if (v === "offline") return setFocus(`<span class="ic">${ICON.offline}</span><br/>Signer offline`, offlineMsg, `<button data-act="retry">Try again</button>`);
  if (v === "tab-error") return setFocus(`<span class="ic">${ICON.tab}</span><br/>Tab audio is off`, esc(tabDetail || "Choose Tab audio in the SIGNLAYER menu"));
  setFocus("", "");
  // Hints live in the sheet, as quiet secondary text.
  cc.dataset.empty =
    v === "ad" ? "Signing resumes after the ad"
    : v === "need-cc" ? "Turn on CC in the player"
    : v === "paused" ? ""
    : phrases ? ""
    : s.source === "tab" ? (tabState === "listening" || tabState === "starting" ? "Listening to this tab…" : "Choose Tab audio in the SIGNLAYER menu")
    : s.source === "mic" ? (tabDetail || "Open the mic panel from the SIGNLAYER menu")
    : s.source === "selection" ? "Select text, then right-click › Sign with SIGNLAYER"
    : origin === "transcript" ? "Press play. Signs follow the transcript." : "Play the video. Signs follow the captions.";
}

noteActions.addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]")?.dataset.act;
  if (act === "retry") checkHealth();
  if (act === "skip") { shown = null; heardText = ""; renderCaptions(); render(); }
  if (act === "confirm" && shown) {
    const list = confirmPlaylist(shown.res);
    if (!list) return;
    const j: Job = { res: { ...shown.res, playlist: list }, source: shown.source, confirmed: true };
    shown = j;
    jobs.length = 0;
    jobs.push(j);
    advance();
  }
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
/** Clip speed: follows the video's own rate, plus catch-up when behind. */
const rate = () => {
  const b = backlog();
  const catchUp = b > 6 ? 1.3 : b > 3 ? 1.15 : 1;
  const media = job?.source === "captions" ? mediaRate : 1;
  return Math.min(2.5, Math.max(0.5, catchUp * media));
};

let swapToken = 0;
function advance() {
  if (job && idx + 1 < job.res.playlist.length) idx++;
  else {
    job = null;
    idx = -1;
    while (jobs.length) {
      const j = jobs.shift()!;
      shown = j;
      heardText = "";
      if (j.res.playlist.length) {
        job = j;
        idx = 0;
        break;
      }
    }
  }
  if (!job) {
    renderCaptions();
    render();
    showNeutral();
    return;
  }
  const item = job.res.playlist[idx]!;
  const back = vids[1 - front]!, cur = vids[front]!;
  load(back, item.url);
  if (back.currentTime > 0.01) back.currentTime = 0;
  back.playbackRate = rate();
  let swapped = false;
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

vids.forEach((v) => {
  v.addEventListener("ended", () => v === vids[front] && job && advance());
  v.addEventListener("error", () => {
    if (v === vids[front] && job && v.getAttribute("src")) { console.warn("[signlayer] clip failed", v.src); advance(); }
  });
});

/** Follow the page video: pause the signer when it pauses, resume when it plays, match its speed. */
function syncPlayback() {
  const v = vids[front]!;
  if (!job) return;
  const hold = srcState.kind === "paused" && job.source === "captions";
  if (hold && !v.paused) v.pause();
  else if (!hold && v.paused && !v.ended && v.getAttribute("src")) v.play().catch(() => {});
  const r = rate();
  if (Math.abs(v.playbackRate - r) > 0.01) v.playbackRate = r;
}

function enqueue(j: Job) {
  if (j.source !== "selection") {
    // Live media: never fall far behind. Drop whole not-yet-started lines beyond ~8 s of backlog.
    while (jobs.length && backlog() > 8) jobs.shift();
  }
  jobs.push(j);
  if (!job) advance();
  else {
    const next = peek();
    if (next) load(vids[1 - front]!, next.url);
  }
}

function clearQueuedVideo() {
  jobs.length = 0;
  job = null;
  idx = -1;
  front = 0;
  swapToken++;
  vids.forEach((v) => { v.pause(); v.removeAttribute("src"); delete v.dataset.url; v.load(); v.classList.remove("on", "top"); });
}

function showBlocked(j: Job) {
  clearQueuedVideo();
  shown = j;
  heardText = "";
  render();
  renderCaptions();
}

/** needs_confirmation: the plan's signs as a playlist, only if every item is a sign we have a clip for. */
let vocab = new Map<string, number>();
function confirmPlaylist(res: SignResponse): PlaylistItem[] | null {
  const plan = res.plan as { items?: { type: string; motion_id?: string; gloss?: string; source_index?: number }[]; unsupported_tokens?: string[] } | null;
  if (res.safety?.status !== "needs_confirmation" || !plan?.items?.length || plan.unsupported_tokens?.length) return null;
  const soft = new Set(["ambiguous_sense", "semantic_uncertainty", "semantic_substitution"]);
  if (res.safety.reasons.some((r) => !soft.has(r.code))) return null;
  const out: PlaylistItem[] = [];
  for (const it of plan.items) {
    if (it.type !== "sign" || !it.motion_id || !vocab.has(it.motion_id)) return null;
    out.push({ motion_id: it.motion_id, gloss: it.gloss ?? it.motion_id.replace(/_/g, " "), url: `${client.base}${ROUTES.clips}${it.motion_id}.mp4`,
      duration_s: vocab.get(it.motion_id)!, word_index: Number.isInteger(it.source_index) ? it.source_index! : -1 });
  }
  return out;
}

// ── Captions (sheet) ──
const CHUNK: Record<Size, number> = { s: 6, m: 8, l: 10 };
let chunkKey = "";
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

function renderCaptions() {
  cc.classList.toggle("pending", pending && !job && !!heardText);
  if (heardText && !job) {
    const ws = heardText.split(/\s+/).filter(Boolean).slice(-CHUNK[s.size] - 2);
    const key = `heard|${heardText}|${s.size}`;
    if (key !== chunkKey) {
      chunkKey = key;
      cc.innerHTML = `<i class="hl"></i>${ws.map((w, k) => `<span class="w heard" style="--k:${k}">${esc(w)}</span>`).join(" ")}`;
    }
    return;
  }
  const j = job ?? shown;
  if (!j || blocked(j)) {
    // Blocked phrases are shown large on the stage (renderFocus); the sheet carries the reason.
    if (cc.innerHTML) cc.innerHTML = "";
    chunkKey = "";
    return;
  }
  const res = j.res;
  const playing = job ? idx : res.playlist.length;
  const frame = res.playlist.length ? captionFrame(res, res.words.length, playing) : null;
  const states = frame?.states ?? res.words.map(() => "heard" as const);
  const unsupported = new Set([...res.unsupported, ...(res.fingerspell ?? [])].map(bare));
  // Balanced chunks (9 words at 8 a line -> 5 + 4, never a lone last word).
  const len = res.words.length;
  const n = Math.ceil(len / Math.max(1, Math.ceil(len / CHUNK[s.size])));
  let focus = states.indexOf("now");
  if (focus < 0) focus = job ? Math.max(0, states.lastIndexOf("signed")) : len - 1;
  const start = Math.floor(Math.max(0, focus) / n) * n;
  const key = `${res.text}|${start}|${n}`;
  if (key !== chunkKey) {
    chunkKey = key;
    cc.innerHTML = `<i class="hl"></i>` + res.words.slice(start, start + n).map((w, k) => {
      const ns = unsupported.has(bare(w));
      return `<span class="w${ns ? " nosign" : ""}" data-i="${start + k}" style="--k:${k}"${ns ? ' title="No sign yet"' : ""}>${esc(w)}</span>`;
    }).join(" ");
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
    // offsetLeft/Top are layout positions (the words' entry transform doesn't move them), so this is exact at once.
    hl.style.transform = `translate(${target.offsetLeft - 4}px, ${target.offsetTop}px)`;
    hl.style.width = `${target.offsetWidth + 8}px`;
    hl.style.height = `${target.offsetHeight}px`;
    hl.classList.add("show");
  } else hl.classList.remove("show");
}

// ── Requests: start at once (and prefetch the next transcript line), apply in order, skip overtaken live results ──
const cache = new Map<string, Promise<SignResponse>>();
function fetchSign(text: string) {
  let p = cache.get(text);
  if (!p) {
    p = client.sign({ text });
    p.catch(() => cache.delete(text));
    cache.set(text, p);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  }
  return p;
}
const clean = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 500);

let seq = 0;
let epoch = 0; // bumped by "reset" (seek / new video): results from before are dropped
let chain: Promise<void> = Promise.resolve();
function sign(text: string, source: Source, from?: Origin, next?: string) {
  const t = clean(text);
  if (!t) return;
  phrases++;
  if (from) origin = from;
  const id = ++seq;
  const ep = epoch;
  const p = fetchSign(t);
  if (next && clean(next)) setTimeout(() => fetchSign(clean(next)).catch(() => {}), 40);
  if (!job) {
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
      if (id === seq) { pending = false; clearQueuedVideo(); offline(e, t); }
      return;
    }
    if (id === seq) pending = false;
    if (isOffline) { isOffline = false; render(); }
    if (ep !== epoch) return;
    if (source !== "selection" && id < seq - 2) return; // overtaken while waiting: keep up with the media
    const j: Job = { res, source };
    if (blocked(j)) showBlocked(j);
    else enqueue(j);
  });
}

function offline(e: unknown, caption = "") {
  let host = s.apiUrl;
  try { host = new URL(s.apiUrl).host; } catch { /* keep */ }
  offlineMsg = `Can't reach the SIGNLAYER API at ${esc(host)}${caption ? `. Caption: <q>${esc(caption)}</q>` : ""}`;
  console.warn("[signlayer]", e);
  isOffline = true;
  render();
}

async function checkHealth() {
  try {
    await client.health();
    if (isOffline) { isOffline = false; render(); }
    if (!vocab.size) client.vocab().then((v) => { vocab = new Map(v.signs.map((x) => [x.motion_id, x.duration_s])); }).catch(() => {});
    showNeutral();
  } catch (e) {
    offline(e);
  }
}

/** Idle: the signer waits in the shared neutral pose (first frame of a clip). Never during a blocked phrase.
 *  That frame is also painted into the still behind the videos, so a cleared player never shows an empty tile. */
let neutralId: string | null = null;
let stillDone = false;
async function showNeutral() {
  if (job || blocked(shown) || vids[front]!.dataset.url) return;
  try {
    neutralId ??= (await client.vocab()).signs[0]?.motion_id ?? null;
    if (!neutralId || job || blocked(shown) || vids[front]!.dataset.url) return;
    const v = vids[front]!;
    load(v, `${client.base}${ROUTES.clips}${neutralId}.mp4`);
    v.addEventListener("loadeddata", () => {
      paintStill(v);
      if (!job && !blocked(shown)) v.classList.add("on");
    }, { once: true });
  } catch {
    /* idle tile stays dark */
  }
}
function paintStill(v: HTMLVideoElement) {
  if (stillDone || !v.videoWidth) return;
  still.width = v.videoWidth >> 1;
  still.height = v.videoHeight >> 1;
  try {
    still.getContext("2d")!.drawImage(v, 0, 0, still.width, still.height);
    stillDone = true;
  } catch { /* cross-origin without CORS: the tile keeps its dark backdrop */ }
}

// ── Messages from the background ──
let lvlRaf = 0, lvl = 0;
const port = browser.runtime.connect({ name: "overlay" });
port.onMessage.addListener((m: ToOverlay) => {
  if (m.type === "sign") sign(m.text, m.source, m.origin, m.next);
  else if (m.type === "heard") {
    origin = m.source === "mic" ? "mic" : origin;
    if (!job) { heardText = m.text; pending = false; renderCaptions(); render(); }
  } else if (m.type === "source-state") {
    srcState = m.state;
    if (m.state.kind === "listening" || m.state.kind === "paused") origin = m.state.origin;
    if (m.state.kind === "listening") mediaRate = m.state.rate ?? 1;
    render();
  } else if (m.type === "tab-audio-state") {
    if (m.level != null) {
      // The island's dot breathes with the tab's audio level.
      lvl = Math.max(0, Math.min(1, m.level));
      if (!lvlRaf) lvlRaf = requestAnimationFrame(() => { lvlRaf = 0; dot.style.scale = String(1 + lvl * 0.9); });
    }
    if (m.state !== tabState || m.detail !== undefined) {
      tabState = m.state;
      tabDetail = m.detail ?? "";
      if (m.state === "listening") origin = "tab";
      render();
    }
  } else if (m.type === "reset") {
    clearQueuedVideo();
    shown = null;
    heardText = "";
    pending = false;
    epoch++; // anything in flight is now stale
    renderCaptions();
    render();
    showNeutral();
  }
});

applySettings();
checkHealth();
