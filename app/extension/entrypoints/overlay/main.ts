import "./style.css";
import { browser } from "wxt/browser";
import { captionFrame, createSignClient, ROUTES, waveColors, type PlaylistItem, type SignResponse } from "@signlayer/core";
import type { FromOverlay, Origin, SourceState, TabAudioState, ToBackground, ToOverlay } from "@/lib/messages";
import { getSettings, onSettings, setSettings, SOURCE_LABEL, SOURCES, type Settings, type Size, type Source } from "@/lib/settings";
import { $, esc, MARK } from "@/lib/brand";
import { ICON, SOURCE_ICON } from "@/lib/icons";

// The signer: an extension page inside an iframe the content script injects.
//  - Gapless playlist player: two stacked <video>s, the hidden one preloads the next clip, swap on "ended".
//  - Requests start as soon as a phrase arrives (and the next transcript line is fetched ahead); results are applied
//    in order, and live sources skip results that were overtaken, so the signer stays near real time.
//  - Safety gate (docs/semantic-safety.md): caption_only / needs_confirmation stop and clear the player at once and show
//    the exact caption plus the reason. needs_confirmation can be played only after an explicit "Show signs" click.

type Job = { res: SignResponse; source: Source; confirmed?: boolean };
type View = "listening" | "signing" | "caption_only" | "confirm" | "offline" | "paused" | "ad" | "need-cc" | "tab-error";

const card = $("card"), stage = $("stage"), cc = $("cc");
const note = $("note"), noteIc = $("noteIc"), noteTitle = $("noteTitle"), noteText = $("noteText"), noteActions = $("noteActions");
const pillState = $("pillState"), pillSub = $("pillSub");
const srcBtn = $("srcBtn"), srcMenu = $("srcMenu"), ccBtn = $("ccBtn");
const vids = [$("v0") as HTMLVideoElement, $("v1") as HTMLVideoElement];
$("brand").innerHTML = `${MARK}<span class="wm" aria-hidden="true">s<span class="wm-i">ı</span>gnlayer</span>`;
ccBtn.innerHTML = ICON.subtitles;
$("closeBtn").innerHTML = ICON.close;

const post = (m: FromOverlay) => parent.postMessage(m, "*");
const send = (m: ToBackground) => browser.runtime.sendMessage(m).catch(() => undefined);
let s: Settings = await getSettings();
let client = createSignClient(s.apiUrl, { timeoutMs: 12_000 });
let origin: Origin = s.source === "tab" ? "tab" : s.source === "mic" ? "mic" : s.source === "selection" ? "selection" : "captions";
let srcState: SourceState = { kind: "idle" };
let tabState: TabAudioState = "off";
let tabDetail = "";
let offlineMsg = "";
let isOffline = false;
let phrases = 0; // phrases received since load (hides the first-run hint)

// ── Settings + controls ──
function applySettings() {
  document.body.dataset.size = s.size;
  document.querySelectorAll<HTMLButtonElement>("button[data-size]").forEach((b) => b.classList.toggle("on", b.dataset.size === s.size));
  card.classList.toggle("nocc", !s.captions);
  ccBtn.setAttribute("aria-pressed", String(s.captions));
  srcBtn.innerHTML = SOURCE_ICON[s.source];
  srcBtn.title = `Listening to: ${SOURCE_LABEL[s.source]}`;
  client = createSignClient(s.apiUrl, { timeoutMs: 12_000 });
  render();
}
onSettings((patch) => {
  s = { ...s, ...patch };
  if (patch.source) {
    origin = patch.source === "tab" ? "tab" : patch.source === "mic" ? "mic" : patch.source === "selection" ? "selection" : "captions";
    if (patch.source !== "captions") srcState = { kind: "idle" };
  }
  applySettings();
  if ("apiUrl" in patch) checkHealth();
});
document.querySelectorAll<HTMLButtonElement>("button[data-size]").forEach((b) =>
  b.addEventListener("click", () => setSettings({ size: b.dataset.size as Size })),
);
ccBtn.addEventListener("click", () => setSettings({ captions: !s.captions }));
$("closeBtn").addEventListener("click", () => post({ sl: 1, type: "close" }));

// Source switch (menu)
srcMenu.innerHTML = SOURCES.map((src) =>
  `<button role="menuitemradio" data-src="${src}">${SOURCE_ICON[src]}<span class="lbl">${SOURCE_LABEL[src]}</span><span class="chk">${ICON.check}</span></button>`).join("");
function toggleMenu(open: boolean = srcMenu.hidden === true) {
  srcMenu.hidden = !open;
  srcBtn.setAttribute("aria-expanded", String(open));
  card.classList.toggle("bar-on", open);
  srcMenu.querySelectorAll<HTMLButtonElement>("[data-src]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.src === s.source)));
  if (open) srcMenu.querySelector<HTMLButtonElement>(`[data-src="${s.source}"]`)?.focus();
}
srcBtn.addEventListener("click", () => toggleMenu());
srcMenu.addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-src]");
  if (!b) return;
  const src = b.dataset.src as Source;
  toggleMenu(false);
  await setSettings({ source: src, enabled: true });
  if (src === "tab") send({ type: "tab-audio", on: true });
  if (src === "mic") openMicPanel();
});
addEventListener("keydown", (e) => { if (e.key === "Escape" && !srcMenu.hidden) toggleMenu(false); });
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

// ── Drag to any corner (screen coordinates: the iframe moves under the pointer). Starts after 4 px, so clicks stay clicks. ──
let drag: { x: number; y: number; cx: number; cy: number; on: boolean } | null = null;
stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, .menu, .note-actions")) return;
  drag = { x: e.screenX, y: e.screenY, cx: e.clientX, cy: e.clientY, on: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.on) {
    if (Math.hypot(dx, dy) < 4) return;
    drag.on = true;
    stage.classList.add("dragging");
    post({ sl: 1, type: "dragstart", x: drag.cx, y: drag.cy });
  }
  post({ sl: 1, type: "drag", dx, dy });
});
const endDrag = () => {
  if (drag?.on) {
    stage.classList.remove("dragging");
    post({ sl: 1, type: "dragend" });
  }
  drag = null;
};
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);
// Touch / pen: a tap shows the controls for a few seconds.
let barTimer = 0;
stage.addEventListener("pointerup", (e) => {
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
  if (job) return "signing";
  if (blocked(shown)) return shown!.res.safety!.status === "needs_confirmation" ? "confirm" : "caption_only";
  if (srcState.kind === "ad") return "ad";
  if (srcState.kind === "paused") return "paused";
  if (srcState.kind === "need-cc") return "need-cc";
  return "listening";
}

const ORIGIN_LABEL: Record<Origin, string> = { transcript: "Transcript", captions: "Captions", texttrack: "Captions", tab: "Tab audio", mic: "Mic", selection: "Text" };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
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

function render() {
  const v = view();
  card.dataset.state = v;
  const cur = job?.res.playlist[idx];
  const [st, sub] =
    v === "signing" ? ["Signing", cur?.gloss ?? ""]
    : v === "caption_only" ? ["Captions only", ""]
    : v === "confirm" ? ["Confirm signs?", ""]
    : v === "offline" ? ["Offline", ""]
    : v === "tab-error" ? ["Tab audio off", ""]
    : v === "paused" ? ["Paused", ""]
    : v === "ad" ? ["Ad playing", ""]
    : v === "need-cc" ? ["Turn on CC", ""]
    : ["Listening", ORIGIN_LABEL[origin]];
  pillState.textContent = st;
  pillSub.textContent = sub ? ` · ${sub}` : "";
  card.classList.toggle("forcecc", v === "caption_only" || v === "confirm");
  renderNote(v);
  cc.dataset.empty = v === "offline" ? "Signer offline" : "Captions appear here";
  wave.active = v === "listening" || v === "caption_only" || v === "confirm";
  if (v === "listening" || v === "paused" || v === "ad" || v === "need-cc") showNeutral();
}

function setNote(kind: "" | "center" | "hint", ic = "", title = "", text = "", actions = "") {
  note.className = `note${kind === "hint" ? " hint" : ""}${kind ? " show" : ""}`;
  noteIc.innerHTML = ic;
  noteTitle.textContent = title;
  noteTitle.hidden = !title;
  noteText.innerHTML = text;
  noteActions.innerHTML = actions;
}

function renderNote(v: View) {
  const res = shown?.res;
  if (v === "caption_only" && res) return setNote("center", ICON.captions, "Can't sign this yet", reasonLine(res));
  if (v === "confirm" && res) {
    const amb = res.safety!.reasons.filter((r) => r.code === "ambiguous_sense").flatMap((r) => r.tokens);
    const glosses = confirmPlaylist(res)?.map((p) => p.gloss).join(" ");
    const why = amb.length ? `${quoteList(amb)} could mean more than one thing` : "These signs are a paraphrase";
    const text = `${why}${glosses ? `. Signs: <span class="gl">${esc(glosses)}</span>` : ""}`;
    const actions = (glosses ? `<button class="primary" data-act="confirm">${ICON.play}Show signs</button>` : "") + `<button data-act="skip">Skip</button>`;
    return setNote("center", ICON.question, "Confirm signs?", text, actions);
  }
  if (v === "offline") return setNote("center", ICON.offline, "Signer offline", offlineMsg, `<button data-act="retry">Try again</button>`);
  if (v === "tab-error") return setNote("center", ICON.tab, "Tab audio is off", esc(tabDetail || "Choose Tab audio in the SIGNLAYER menu"));
  if (v === "ad") return setNote("hint", "", "", "Ad playing · signing resumes after it");
  if (v === "need-cc") return setNote("hint", "", "", "Turn on CC in the player");
  if (v === "listening" && !phrases && !job && !heardText) {
    const hint =
      s.source === "tab" ? (tabState === "listening" || tabState === "starting" ? "Listening to this tab" : "Choose Tab audio in the SIGNLAYER menu")
      : s.source === "mic" ? (tabDetail || "Open the mic panel from the SIGNLAYER menu")
      : s.source === "selection" ? "Select text · right-click · Sign with SIGNLAYER"
      : origin === "transcript" ? "Transcript ready · press play" : "Play the video · signing follows the captions";
    return setNote("hint", "", "", hint);
  }
  setNote("");
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

// ── Gapless playlist player ──
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
const rate = () => (backlog() > 6 ? 1.3 : backlog() > 3 ? 1.15 : 1);

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
  const swap = () => {
    if (swapped) return;
    swapped = true;
    back.classList.add("on");
    cur.classList.remove("on");
    cur.pause();
    front = 1 - front;
    const next = peek();
    if (next) load(cur, next.url);
  };
  back.requestVideoFrameCallback?.(swap);
  back.addEventListener("playing", () => setTimeout(swap, 30), { once: true });
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
    if (v === vids[front] && job) { console.warn("[signlayer] clip failed", v.src); advance(); }
  });
});

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
  vids.forEach((v) => { v.pause(); v.removeAttribute("src"); delete v.dataset.url; v.load(); v.classList.remove("on"); });
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

// ── Captions ──
const CHUNK: Record<Size, number> = { s: 7, m: 10, l: 13 };
let chunkKey = "";
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

function renderCaptions() {
  cc.classList.toggle("pending", pending && !job && !!heardText);
  if (heardText && !job) {
    const words = heardText.split(/\s+/).filter(Boolean).slice(-CHUNK[s.size] - 4);
    const key = `heard|${heardText}`;
    if (key !== chunkKey) {
      chunkKey = key;
      cc.innerHTML = `<i class="hl"></i>${words.map((w) => `<span class="w heard">${esc(w)}</span>`).join(" ")}`;
    }
    return;
  }
  const j = job ?? shown;
  if (!j) {
    cc.innerHTML = "";
    chunkKey = "";
    return;
  }
  const res = j.res;
  const isBlocked = blocked(j);
  // Blocked: the exact caption (safety.caption), every word solid; words the signer can't do are marked.
  if (isBlocked) {
    const caption = res.safety!.caption;
    const key = `blocked|${caption}`;
    if (key !== chunkKey) {
      chunkKey = key;
      const bad = new Set([...res.unsupported, ...(res.fingerspell ?? []), ...res.safety!.reasons.flatMap((r) => r.tokens)].map(bare));
      const words = caption.split(/\s+/).filter(Boolean);
      const n = CHUNK[s.size] + 6;
      const tail = words.length > n ? ["…", ...words.slice(-n)] : words;
      cc.innerHTML = `<i class="hl"></i>${tail.map((w) => `<span class="w caption${bad.has(bare(w)) ? " nosign" : ""}">${esc(w)}</span>`).join(" ")}`;
    }
    return;
  }
  const playing = job ? idx : res.playlist.length;
  const frame = res.playlist.length ? captionFrame(res, res.words.length, playing) : null;
  const states = frame?.states ?? res.words.map(() => "heard" as const);
  const unsupported = new Set([...res.unsupported, ...(res.fingerspell ?? [])].map(bare));
  const n = CHUNK[s.size];
  let focus = states.indexOf("now");
  if (focus < 0) focus = job ? Math.max(0, states.lastIndexOf("signed")) : res.words.length - 1;
  const start = Math.floor(Math.max(0, focus) / n) * n;
  const key = `${res.text}|${start}|${n}`;
  if (key !== chunkKey) {
    chunkKey = key;
    cc.innerHTML = `<i class="hl"></i>` + res.words.slice(start, start + n).map((w, k) => {
      const ns = unsupported.has(bare(w));
      return `<span class="w${ns ? " nosign" : ""}" data-i="${start + k}"${ns ? ' title="No sign yet"' : ""}>${esc(w)}</span>`;
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
    hl.style.transform = `translate(${target.offsetLeft - 3}px, ${target.offsetTop - 1}px)`;
    hl.style.width = `${target.offsetWidth + 6}px`;
    hl.style.height = `${target.offsetHeight + 2}px`;
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
  wave.pulse();
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
  offlineMsg = `Can't reach the SIGNLAYER API at ${esc(host)}${caption ? `.<br/>Caption: <q>${esc(caption)}</q>` : ""}`;
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

/** Idle: the signer waits in the shared neutral pose (first frame of a clip). Never during a blocked phrase. */
let neutralId: string | null = null;
async function showNeutral() {
  if (job || blocked(shown) || vids[front]!.dataset.url) return;
  try {
    neutralId ??= (await client.vocab()).signs[0]?.motion_id ?? null;
    if (!neutralId || job || blocked(shown) || vids[front]!.dataset.url) return;
    const v = vids[front]!;
    load(v, `${client.base}${ROUTES.clips}${neutralId}.mp4`);
    v.addEventListener("loadeddata", () => !job && !blocked(shown) && v.classList.add("on"), { once: true });
  } catch {
    /* idle tile stays dark */
  }
}

// ── Listening wave (the app's SignWave): calm while idle, lifts on each phrase / with tab audio level ──
const wave = (() => {
  const c = $("wave") as HTMLCanvasElement;
  const g = c.getContext("2d")!;
  let level = 0.12, target = 0.12, raf = 0, active = true;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function draw(t: number) {
    raf = 0;
    if (!active || document.hidden || reduce) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    level += (target - level) * 0.08;
    target += (0.12 - target) * 0.02;
    const lines = 4;
    for (let k = 0; k < lines; k++) {
      const col = waveColors[(k + 1) % waveColors.length];
      g.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const u = x / w;
        const env = Math.sin(Math.PI * u) ** 1.6;
        const y = h * 0.62 + Math.sin(u * (7 + k * 1.7) + t / (520 - k * 70) + k) * env * h * 0.42 * level * (1 - k * 0.15);
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = `rgba(${col}, ${0.85 - k * 0.16})`;
      g.lineWidth = 1.6 - k * 0.2;
      g.shadowColor = `rgba(${col}, .8)`;
      g.shadowBlur = 6;
      g.stroke();
    }
    raf = requestAnimationFrame(draw);
  }
  const kick = () => { if (!raf && active && !reduce) raf = requestAnimationFrame(draw); };
  document.addEventListener("visibilitychange", kick);
  return {
    set active(on: boolean) { active = on; if (on) kick(); },
    pulse(x = 0.85) { target = Math.max(target, x); kick(); },
    level(x: number) { target = Math.max(0.12, Math.min(1, x)); kick(); },
  };
})();

// ── Messages from the background ──
const port = browser.runtime.connect({ name: "overlay" });
port.onMessage.addListener((m: ToOverlay) => {
  if (m.type === "sign") sign(m.text, m.source, m.origin, m.next);
  else if (m.type === "heard") {
    origin = m.source === "mic" ? "mic" : origin;
    if (!job) { heardText = m.text; pending = false; renderCaptions(); render(); }
  } else if (m.type === "source-state") {
    srcState = m.state;
    if (m.state.kind === "listening" || m.state.kind === "paused") origin = m.state.origin;
    render();
  } else if (m.type === "tab-audio-state") {
    if (m.level != null) wave.level(m.level);
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
