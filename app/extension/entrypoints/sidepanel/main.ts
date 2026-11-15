import "./style.css";
import { browser } from "wxt/browser";
import { captionFrame, createSignClient, ROUTES, type PlaylistItem, type SignResponse } from "@signlayer/core";
import { $, esc, ICON, MARK, WORDMARK } from "@/lib/brand";
import { getSettings, setSettings, type Source } from "@/lib/settings";
import { createListener, speechSupported } from "@/lib/speech";
import { TabAudio } from "@/lib/tab-audio";

// The side panel is the whole product:
//   Mic (Web Speech API, here) or Tab audio (tabCapture stream, recorded here, /api/transcribe) ─► phrases
//   ─► POST /api/sign (in parallel; applied in order; overtaken live results skipped) ─► playlist
//   ─► two stacked <video>s: the next clip preloads in the hidden one and crossfades in on its first painted frame.
// Safety gate (docs/semantic-safety.md): caption_only / needs_confirmation stop and clear the player at once; the
// still blurs back and the exact caption comes forward with the reason. needs_confirmation plays only after a click.

type Job = { res: SignResponse; confirmed?: boolean };
type View = "ready" | "starting" | "listening" | "signing" | "caption_only" | "confirm" | "offline" | "error";
type Tone = "live" | "sign" | "warn" | "off" | "idle";
const BLOCKED = new Set<View>(["caption_only", "confirm", "offline", "error"]);
const SRC_LABEL: Record<Source, string> = { mic: "Mic", tab: "Tab audio" };

const stage = $("stage"), cc = $("cc"), note = $("note"), focusText = $("focusText"), actions = $("actions");
const island = $("pill"), islandIn = $("islandIn"), dot = $("dot"), pillState = $("pillState"), pillSub = $("pillSub");
const go = $("go"), goText = $("goText"), seg = $("seg");
const vids = [$("v0") as HTMLVideoElement, $("v1") as HTMLVideoElement];
const still = $("still") as HTMLCanvasElement;
$("brand").innerHTML = MARK + WORDMARK;
$("gear").innerHTML = ICON.gear;
$("icMic").innerHTML = ICON.mic;
$("icTab").innerHTML = ICON.tab;

let s = await getSettings();
let client = createSignClient(s.apiUrl, { timeoutMs: 12_000 });

// ── Listening state ──
let listening: "off" | "starting" | "on" = "off";
let errorText = ""; // capture / mic error: shown on the stage until the next Start
let hint = ""; // soft line under the captions while listening
let isOffline = false, offlineMsg = "";

// ── Controls ──
function renderControls() {
  seg.dataset.src = s.source;
  seg.querySelectorAll<HTMLButtonElement>("[data-src]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.src === s.source)));
  const on = listening !== "off";
  go.setAttribute("aria-pressed", String(on));
  go.classList.toggle("starting", listening === "starting");
  $("goIc").innerHTML = on ? ICON.stop : s.source === "tab" ? ICON.tab : ICON.mic;
  goText.textContent = listening === "starting" ? "Starting…" : on ? "Stop" : s.source === "tab" ? "Listen to this tab" : "Start listening";
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
  if (was) startListening(); // still inside the click: tab capture may start
});
seg.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const other = seg.querySelector<HTMLButtonElement>(`[data-src="${s.source === "mic" ? "tab" : "mic"}"]`)!;
  other.click();
  other.focus();
});
go.addEventListener("click", () => (listening === "off" ? startListening() : stopListening()));

// Server URL: a tiny gear, an inline field.
const form = $("server") as HTMLFormElement, urlIn = $("apiUrl") as HTMLInputElement;
$("gear").addEventListener("click", () => {
  form.hidden = !form.hidden;
  $("gear").setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) { urlIn.value = s.apiUrl; urlIn.focus(); urlIn.select(); }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = urlIn.value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/i.test(v)) { urlIn.setCustomValidity("http://host:port"); urlIn.reportValidity(); return; }
  urlIn.setCustomValidity("");
  s.apiUrl = v;
  setSettings({ apiUrl: v });
  client = createSignClient(v, { timeoutMs: 12_000 });
  vocab = new Map(); neutralId = null; stillDone = false;
  form.hidden = true;
  $("gear").setAttribute("aria-expanded", "false");
  checkHealth();
});

// ── Sources ──
let tab: TabAudio | null = null;
let mic: ReturnType<typeof createListener> | null = null;
let micWaiting = false; // waiting for the one-time permission tab

/** Test hook: when the panel page is opened as a tab (scripts/verify.mjs), ?tab=<id> names the tab to capture. */
const testTab = Number(new URLSearchParams(location.search).get("tab")) || null;

async function startListening() {
  errorText = ""; hint = "";
  listening = "starting";
  renderControls();
  render();
  if (s.source === "tab") await startTab();
  else await startMic();
  renderControls();
  render();
}

function stopListening() {
  tab?.stop(); tab = null;
  mic?.stop(); mic = null;
  micWaiting = false;
  listening = "off";
  hint = "";
  if (!job) heardText = "";
  setLevel(0);
  renderControls();
  renderCaptions();
  render();
}

function fail(text: string) {
  tab?.stop(); tab = null;
  mic?.stop(); mic = null;
  listening = "off";
  errorText = text;
  setLevel(0);
  renderControls();
  render();
}

async function startTab() {
  let tabId = testTab;
  if (!tabId) {
    const [t] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = t?.id ?? null;
  }
  if (!tabId) return fail("No tab to listen to. Open a page that plays audio.");
  const t = new TabAudio(s.apiUrl, {
    onText: (text) => sign(text),
    onLevel: setLevel,
    onHint: (h) => { hint = h; render(); },
    onError: (e) => fail(e),
  });
  tab = t;
  try {
    await t.start(tabId);
    if (tab !== t) return; // stopped while starting
    listening = "on";
  } catch (e) {
    if (tab === t) fail(e instanceof Error ? e.message : String(e));
  }
}

async function micAllowed() {
  try {
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state === "granted";
  } catch {
    return true; // can't tell: try, and the "denied" error opens the permission tab
  }
}

function openMicTab() {
  micWaiting = true;
  hint = "Allow the microphone in the tab that just opened. Listening starts by itself.";
  browser.tabs.create({ url: browser.runtime.getURL("/mic.html") });
}

async function startMic() {
  if (!speechSupported()) return fail("Speech recognition isn't available in this browser.");
  if (!(await micAllowed())) { openMicTab(); return; }
  mic = createListener({
    onInterim: (t) => { if (t && !job) { heardText = t; pending = false; renderCaptions(); } },
    onFinal: (t) => sign(t),
    onError: (kind, raw) => {
      if (kind === "denied") { mic = null; listening = "starting"; openMicTab(); renderControls(); render(); }
      else if (kind === "no-mic") fail("No microphone found. Plug one in and press Start.");
      else if (kind === "network") { hint = "Speech recognition needs the internet. Retrying…"; render(); }
      else fail(`Speech recognition stopped (${raw}).`);
    },
  });
  mic.start();
  listening = "on";
}

// The permission tab tells us when the mic is allowed.
browser.runtime.onMessage.addListener((m: unknown) => {
  if ((m as { type?: string })?.type !== "mic-granted" || !micWaiting) return;
  micWaiting = false;
  hint = "";
  if (s.source === "mic") startListening();
});

let lvlRaf = 0, lvl = 0;
function setLevel(x: number) {
  lvl = x;
  if (!lvlRaf) lvlRaf = requestAnimationFrame(() => {
    lvlRaf = 0;
    go.style.setProperty("--lvl", lvl.toFixed(3));
    dot.style.setProperty("--lvl", lvl.toFixed(3));
  });
}

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
  if (errorText) return "error";
  if (job) return "signing";
  if (blocked(shown)) return shown!.res.safety!.status === "needs_confirmation" ? "confirm" : "caption_only";
  if (listening === "starting") return "starting";
  if (listening === "on") return "listening";
  return "ready";
}

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

// ── Status capsule: width springs to each label, the label blurs in ──
let islandKey = "";
function setIsland(tone: Tone, state: string, sub = "", subGloss = false) {
  const key = `${tone}|${state}|${sub}`;
  if (key === islandKey) return;
  const first = !islandKey;
  islandKey = key;
  island.dataset.tone = tone;
  const from = island.getBoundingClientRect().width;
  pillState.textContent = state;
  pillSub.textContent = sub;
  pillSub.className = subGloss ? "gl" : "";
  pillSub.hidden = !sub;
  island.style.width = "auto";
  const to = islandIn.getBoundingClientRect().width;
  if (!first && from > 0) { island.style.width = `${from}px`; void island.offsetWidth; }
  island.style.width = `${Math.ceil(to)}px`;
  if (!first) { islandIn.classList.remove("morph"); void islandIn.offsetWidth; islandIn.classList.add("morph"); }
}

function render() {
  const v = view();
  stage.dataset.state = v;
  stage.classList.toggle("blocked", BLOCKED.has(v));
  document.body.dataset.state = v;
  const cur = job?.res.playlist[idx];
  if (v === "signing") setIsland("sign", "Signing", cur?.gloss ?? "", true);
  else if (v === "caption_only") setIsland("warn", "Can't sign yet");
  else if (v === "confirm") setIsland("warn", "Confirm signs?");
  else if (v === "offline") setIsland("off", "Offline");
  else if (v === "error") setIsland("off", s.source === "tab" ? "Tab audio off" : "Mic off");
  else if (v === "starting") setIsland("idle", "Starting");
  else if (v === "listening") setIsland("live", "Listening", SRC_LABEL[s.source]);
  else setIsland("idle", "Ready");
  renderFocus(v);
  if (!BLOCKED.has(v) && v !== "signing") showNeutral();
}

let focusKey = "";
function setFocus(html: string, reason = "", acts = "", len = 0) {
  const key = `${html}|${acts}`;
  if (key !== focusKey) {
    focusKey = key;
    focusText.innerHTML = html;
    focusText.dataset.len = len > 22 ? "l" : len > 11 ? "m" : "s";
    actions.innerHTML = acts;
  }
  note.innerHTML = reason;
}
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
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
    const acts = (glosses ? `<button class="primary" data-act="confirm">${ICON.play}Show signs</button>` : "") + `<button data-act="skip">Skip</button>`;
    return setFocus(words(caption) + (glosses ? `<span class="gl">${esc(glosses)}</span>` : ""), why, acts, caption.split(/\s+/).length + 4);
  }
  if (v === "offline") return setFocus(`<span class="ic">${ICON.offline}</span><br/>Signer offline`, offlineMsg, `<button data-act="retry">Try again</button>`);
  if (v === "error") return setFocus(`<span class="ic">${s.source === "tab" ? ICON.tab : ICON.mic}</span><br/>${s.source === "tab" ? "Tab audio is off" : "Mic is off"}`, esc(errorText));
  setFocus("", "");
  cc.dataset.empty = hint ? hint
    : v === "listening" ? (s.source === "tab" ? "Listening to this tab…" : "Listening… speak near your computer.")
    : v === "starting" ? ""
    : s.source === "tab" ? "Play something in this tab, then press Listen."
    : "Press Start and speak.";
}

actions.addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]")?.dataset.act;
  if (act === "retry") checkHealth();
  if (act === "skip") { shown = null; heardText = ""; renderCaptions(); render(); }
  if (act === "confirm" && shown) {
    const list = confirmPlaylist(shown.res);
    if (!list) return;
    const j: Job = { res: { ...shown.res, playlist: list }, confirmed: true };
    shown = j;
    jobs.length = 0;
    jobs.push(j);
    clearTimeout(holdTimer);
    holdTimer = 0;
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
const rate = () => { const b = backlog(); return b > 6 ? 1.3 : b > 3 ? 1.15 : 1; };

let swapToken = 0;
let swapping = false; // the back video is starting: don't load anything else into it until it is on screen
let holdTimer = 0; // a caption-only phrase stays readable this long before the next phrase plays
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
        // Its turn came (after the phrase before it finished signing): the player stops and clears, the exact
        // caption and the reason come forward.
        stopVideo();
        renderCaptions();
        render();
        holdTimer = window.setTimeout(() => { holdTimer = 0; if (!job && jobs.length) advance(); }, Math.min(4000, 1600 + j.res.words.length * 180));
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

vids.forEach((v) => {
  v.addEventListener("ended", () => v === vids[front] && job && advance());
  v.addEventListener("error", () => {
    if (v === vids[front] && job && v.getAttribute("src")) { console.warn("[signlayer] clip failed", v.src); advance(); }
  });
});

function enqueue(j: Job) {
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

// ── Captions: words blur in, the word being signed is highlighted, words without a sign are muted ──
const CHUNK = 9;
let chunkKey = "";
function renderCaptions() {
  cc.classList.toggle("pending", pending && !job && !!heardText);
  if (heardText && !job) {
    const ws = heardText.split(/\s+/).filter(Boolean).slice(-CHUNK - 3);
    const key = `heard|${heardText}`;
    if (key !== chunkKey) {
      chunkKey = key;
      cc.innerHTML = `<i class="hl"></i>${ws.map((w, k) => `<span class="w heard" style="--k:${k}">${esc(w)}</span>`).join(" ")}`;
    }
    return;
  }
  const j = job ?? shown;
  if (!j || blocked(j)) {
    if (cc.innerHTML) cc.innerHTML = "";
    chunkKey = "";
    return;
  }
  const res = j.res;
  const playing = job ? idx : res.playlist.length;
  const frame = res.playlist.length ? captionFrame(res, res.words.length, playing) : null;
  const states = frame?.states ?? res.words.map(() => "heard" as const);
  const unsupported = new Set([...res.unsupported, ...(res.fingerspell ?? [])].map(bare));
  // Balanced chunks (never a lone last word).
  const len = res.words.length;
  const n = Math.ceil(len / Math.max(1, Math.ceil(len / CHUNK)));
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
    hl.style.transform = `translate(${target.offsetLeft - 5}px, ${target.offsetTop}px)`;
    hl.style.width = `${target.offsetWidth + 10}px`;
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
      if (id === seq) { pending = false; clearVideo(); offline(e, t); }
      return;
    }
    if (id === seq) pending = false;
    if (isOffline) { isOffline = false; render(); }
    dbg.phrases.push({ text: t, status: res.safety?.status ?? "?", glosses: res.playlist.map((x) => x.gloss).join(" ") });
    if (id < seq - 2) return; // overtaken while waiting: keep up with the speech
    // Blocked phrases queue in order like the rest: one arriving mid-signing waits for that phrase to finish.
    enqueue({ res });
  });
}

function offline(e: unknown, caption = "") {
  let host = s.apiUrl;
  try { host = new URL(s.apiUrl).host; } catch { /* keep */ }
  offlineMsg = `Can't reach the SIGNLAYER server at ${esc(host)}${caption ? `. Caption: <q>${esc(caption)}</q>` : ""}`;
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

/** Idle: the signer waits in the neutral pose (first frame of a clip), also painted into the still behind the videos. */
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

addEventListener("pagehide", () => { tab?.stop(); mic?.stop(); });

renderControls();
render();
checkHealth();
