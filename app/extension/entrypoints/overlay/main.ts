import "./style.css";
import { browser } from "wxt/browser";
import { captionFrame, createSignClient, ROUTES, type PlaylistItem, type SignResponse } from "@signlayer/core";
import type { FromOverlay, ToOverlay } from "@/lib/messages";
import { getSettings, onSettings, setSettings, type Settings, type Size, type Source } from "@/lib/settings";
import { $, esc, MARK, WORDMARK } from "@/lib/brand";

// The signer: an extension page inside an iframe the content script injects.
// Gapless playlist player (two stacked <video>s: the hidden one preloads the next clip, swap on "ended"),
// caption sheet with word states (captionFrame), S/M/L, captions toggle, drag handle.

type Job = { res: SignResponse; source: Source };

const card = $("card"), grip = $("grip"), cc = $("cc"), idleEl = $("idle"), live = $("live");
const chipState = $("chipState"), chipSub = $("chipSub");
const vids = [$("v0") as HTMLVideoElement, $("v1") as HTMLVideoElement];
$("brand").innerHTML = MARK + WORDMARK;

const post = (m: FromOverlay) => parent.postMessage(m, "*");
let s: Settings = await getSettings();
let client = createSignClient(s.apiUrl);
let lastSource: Source = s.source;

// ── Settings ──
function applySettings() {
  document.body.dataset.size = s.size;
  document.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) => b.classList.toggle("on", b.dataset.size === s.size));
  card.classList.toggle("nocc", !s.captions);
  $("ccBtn").setAttribute("aria-pressed", String(s.captions));
  client = createSignClient(s.apiUrl);
  renderStatus();
}
onSettings((patch) => {
  s = { ...s, ...patch };
  if ("source" in patch && patch.source) lastSource = patch.source;
  applySettings();
  if ("apiUrl" in patch) checkHealth();
});
document.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) =>
  b.addEventListener("click", () => setSettings({ size: b.dataset.size as Size })),
);
$("ccBtn").addEventListener("click", () => setSettings({ captions: !s.captions }));
$("closeBtn").addEventListener("click", () => post({ sl: 1, type: "close" }));

// ── Height -> content script (the iframe follows the card) ──
new ResizeObserver(() => post({ sl: 1, type: "height", h: card.offsetHeight })).observe(card);

// ── Drag to any corner (screen coordinates: the iframe moves under the pointer) ──
let drag: { x: number; y: number } | null = null;
grip.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  drag = { x: e.screenX, y: e.screenY };
  grip.setPointerCapture(e.pointerId);
  grip.classList.add("dragging");
});
grip.addEventListener("pointermove", (e) => {
  if (drag) post({ sl: 1, type: "drag", dx: e.screenX - drag.x, dy: e.screenY - drag.y });
});
const endDrag = () => {
  if (!drag) return;
  drag = null;
  grip.classList.remove("dragging");
  post({ sl: 1, type: "dragend" });
};
grip.addEventListener("pointerup", endDrag);
grip.addEventListener("pointercancel", endDrag);

// ── Status chip ("Listening" / "Translating" / "Signing") ──
type Status = "listening" | "translating" | "signing" | "nosign" | "offline";
let status: Status = "listening";
let offlineMsg = "";
const SOURCE_SUB: Record<Source, string> = { captions: "Captions", mic: "Microphone", selection: "Selected text" };
const IDLE_HINT: Record<Source, string> = {
  captions: "Turn on CC in the video. The signer follows the captions",
  mic: "Open the SIGNLAYER side panel and tap Listen",
  selection: "Select text, right-click › Sign with SIGNLAYER (Alt+Shift+S)",
};

function setStatus(st: Status) {
  status = st;
  renderStatus();
}
function renderStatus() {
  const cur = job?.res.playlist[idx];
  card.classList.toggle("signing", status === "signing");
  card.classList.toggle("err", status === "offline");
  live.classList.toggle("off", status !== "signing");
  live.classList.toggle("err", status === "offline");
  const [st, sub] =
    status === "signing" ? ["Signing", cur?.gloss ?? ""]
    : status === "translating" ? ["Translating", SOURCE_SUB[lastSource]]
    : status === "nosign" ? ["Can't sign yet", ""]
    : status === "offline" ? ["Offline", "API"]
    : ["Listening", SOURCE_SUB[lastSource]];
  chipState.textContent = st;
  chipSub.textContent = sub ? ` · ${sub}` : "";
  idleEl.textContent = status === "offline" ? offlineMsg : IDLE_HINT[lastSource];
  cc.dataset.empty = status === "offline" ? "Signer offline" : "Captions appear here";
}

// ── Gapless playlist player ──
const jobs: Job[] = [];
let job: Job | null = null; // job being signed
let shown: Job | null = null; // job whose captions are on screen
let idx = -1;
let front = 0;
let heardText = "";

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
    setStatus(shown && !shown.res.playlist.length ? "nosign" : "listening");
    return;
  }
  lastSource = job.source;
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
  setStatus("signing");
  renderCaptions();
}

vids.forEach((v) => {
  v.addEventListener("ended", () => v === vids[front] && advance());
  v.addEventListener("error", () => {
    if (v === vids[1 - front] && job) console.warn("[signlayer] clip failed", v.src);
  });
});

function enqueue(j: Job) {
  if (j.source === "captions") {
    // Live captions: never fall far behind. Drop whole not-yet-started lines beyond ~8 s of backlog.
    while (jobs.length && backlog() > 8) jobs.shift();
  }
  jobs.push(j);
  if (!job) advance();
  else {
    const next = peek();
    if (next) load(vids[1 - front]!, next.url);
  }
}

// ── Captions ──
const CHUNK: Record<Size, number> = { s: 6, m: 9, l: 12 };
let chunkKey = "";

function renderCaptions() {
  if (heardText && !job) {
    const words = heardText.split(/\s+/).filter(Boolean).slice(-CHUNK[s.size]);
    cc.innerHTML = `<i class="hl"></i>${words.map((w) => `<span class="w heard">${esc(w)}</span>`).join(" ")}`;
    chunkKey = "";
    return;
  }
  const j = job ?? shown;
  if (!j) {
    cc.innerHTML = "";
    chunkKey = "";
    return;
  }
  const res = j.res;
  const playing = job ? idx : res.playlist.length;
  const frame = res.playlist.length ? captionFrame(res, res.words.length, playing) : null;
  const states = frame?.states ?? res.words.map(() => "heard" as const);
  const unsupported = new Set(res.unsupported.map((w) => w.toLowerCase()));
  const n = CHUNK[s.size];
  let focus = states.indexOf("now");
  if (focus < 0) focus = job ? Math.max(0, states.lastIndexOf("signed")) : res.words.length - 1;
  const start = Math.floor(Math.max(0, focus) / n) * n;
  const key = `${res.text}|${start}|${n}`;
  if (key !== chunkKey) {
    chunkKey = key;
    cc.innerHTML =
      `<i class="hl"></i>` +
      res.words
        .slice(start, start + n)
        .map((w, k) => {
          const bare = w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
          return `<span class="w${unsupported.has(bare) ? " nosign" : ""}" data-i="${start + k}"${unsupported.has(bare) ? ' title="Can\'t sign yet"' : ""}>${esc(w)}</span>`;
        })
        .join(" ");
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

// ── Requests ──
let chain: Promise<void> = Promise.resolve();
function sign(text: string, source: Source) {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 600);
  if (!clean) return;
  lastSource = source;
  chain = chain.then(async () => {
    if (!job) setStatus("translating");
    try {
      const res = await client.sign({ text: clean });
      if (status === "offline") setStatus("listening");
      enqueue({ res, source });
    } catch (e) {
      offline(e);
    }
  });
}

function offline(e: unknown) {
  offlineMsg = `Can't reach the SIGNLAYER API at ${s.apiUrl}. Start it, or set the URL in the extension menu`;
  console.warn("[signlayer]", e);
  setStatus("offline");
}

async function checkHealth() {
  try {
    await client.health();
    if (status === "offline") setStatus("listening");
    showNeutral();
  } catch (e) {
    offline(e);
  }
}

/** Show the signer in the shared neutral pose (first frame of any clip) while idle. */
async function showNeutral() {
  if (job || vids[front]!.dataset.url) return;
  try {
    const { signs } = await client.vocab();
    const first = signs[0];
    if (!first || job) return;
    const v = vids[front]!;
    load(v, `${client.base}${ROUTES.clips}${first.motion_id}.mp4`);
    v.addEventListener("loadeddata", () => !job && v.classList.add("on"), { once: true });
  } catch {
    /* idle tile stays dark */
  }
}

const port = browser.runtime.connect({ name: "overlay" });
port.onMessage.addListener((m: ToOverlay) => {
  if (m.type === "sign") sign(m.text, m.source);
  else if (m.type === "heard") {
    lastSource = m.source;
    heardText = m.text;
    if (!job) {
      renderCaptions();
      renderStatus();
    }
  }
});

applySettings();
checkHealth();
