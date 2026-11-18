// The phrase queue and the signer: photoreal clips on two stacked <video>s (the next clip preloads in the hidden one
// and crossfades in on its first painted frame), or a whole phrase on the 3D signer. Live speech never falls far
// behind: unstarted phrases beyond ~8 s of backlog are dropped and a backlog plays a little faster.
import { ROUTES, type PlaybackMode, type PlaylistItem, type SignResponse } from "@flux/core";
import { renderCaptions } from "./captions";
import { still, vids } from "./dom";
import { get3d, setMode, stop3d } from "./signer3d";
import { render } from "./status";
import { client } from "./state";

export type Job = { res: SignResponse; mode?: PlaybackMode };

/** What is playing, for the captions and the status. */
export const now = {
  jobs: [] as Job[],
  /** Being signed. */
  job: null as Job | null,
  /** Whose caption is on screen. */
  shown: null as Job | null,
  /** Playlist index in `job` being signed. */
  idx: -1,
  /** Words heard, waiting for their /api/sign answer (shown before the phrase plays). */
  heardText: "",
  /** The newest /api/sign is in flight. */
  pending: false,
  /** A phrase that can't be signed stays readable in the transcript this long before the next one plays. */
  holdTimer: 0,
};
let front = 0;
let gen3d = 0;

/** The safety gate held this phrase back: it isn't signed (the transcript still shows it). */
export const blocked = (j: Job | null) => !!j && !!j.res.safety && j.res.safety.status !== "fully_supported";

function load(v: HTMLVideoElement, url: string) {
  if (v.dataset.url === url) return;
  v.dataset.url = url;
  v.src = url;
  v.load();
}

function peek(): PlaylistItem | undefined {
  const { job, idx, jobs } = now;
  if (job && job.mode !== "3d" && idx + 1 < job.res.playlist.length) return job.res.playlist[idx + 1];
  const j = jobs.find((x) => x.res.playlist.length);
  return j && j.mode !== "3d" ? j.res.playlist[0] : undefined; // a 3D phrase has no clip to preload
}

/** Seconds of signing still queued (drives catch-up speed so the signer stays near real time). */
function backlog() {
  let t = 0;
  if (now.job) now.job.res.playlist.slice(now.idx + 1).forEach((p) => (t += p.duration_s));
  now.jobs.forEach((j) => j.res.playlist.forEach((p) => (t += p.duration_s)));
  return t;
}
const rate = () => { const b = backlog(); return b > 6 ? 1.3 : b > 3 ? 1.15 : 1; };

let swapToken = 0;
let swapping = false; // the back video is starting: don't load anything else into it until it is on screen
function advance() {
  clearTimeout(now.holdTimer);
  now.holdTimer = 0;
  if (now.job && now.idx + 1 < now.job.res.playlist.length) now.idx++;
  else {
    now.job = null;
    now.idx = -1;
    while (now.jobs.length) {
      const j = now.jobs.shift()!;
      now.shown = j;
      now.heardText = "";
      if (blocked(j)) {
        // Its turn came (after the phrase before it finished signing): nothing plays, the signer stays still on its
        // last frame, and the words stay readable in the transcript for a moment.
        renderCaptions();
        render();
        now.holdTimer = window.setTimeout(() => { now.holdTimer = 0; if (!now.job && now.jobs.length) advance(); }, Math.min(3000, 1200 + j.res.words.length * 150));
        return;
      }
      if (j.res.playlist.length) { now.job = j; now.idx = 0; break; }
    }
  }
  const job = now.job;
  if (!job) { renderCaptions(); render(); return; }
  if (job.mode === "3d") { play3d(job); return; }
  const item = job.res.playlist[now.idx]!;
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
    setMode("clips"); // after a 3D phrase: the canvas fades out over the first clip
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
    // Autoplay refused or the source failed: skip ahead rather than hang. (An AbortError only means the clip was
    // stopped or replaced meanwhile: not worth a warning.)
    if ((e as Error)?.name !== "AbortError") console.warn("[flux] play failed", item.url, e);
    swap();
    setTimeout(advance, 0);
  });
  render();
  renderCaptions();
}

/** A whole phrase on the 3D signer (rest -> signs -> rest); captions follow the sign being made. */
function play3d(j: Job) {
  const g = ++gen3d;
  now.idx = -1;
  render();
  renderCaptions();
  const mine = () => g === gen3d && now.job === j;
  get3d().play(j.res.playlist, {
    restUrl: j.res.rest_motion_url,
    onIndex: (k) => {
      if (!mine()) return;
      setMode("3d");
      if (k >= 0 && k !== now.idx) { now.idx = k; renderCaptions(); }
    },
  }).then((finished) => {
    if (!finished || !mine()) return;
    now.idx = j.res.playlist.length - 1;
    advance();
  }).catch((e) => {
    if (!mine()) return;
    console.warn("[flux] 3D signer failed", e);
    // Can't load the 3D signer (network, WebGL): a phrase that has every clip still plays photoreal; else skip it.
    if (j.res.playlist.every((x) => x.url)) { j.mode = "clips"; now.job = null; now.idx = -1; now.jobs.unshift(j); advance(); return; }
    now.idx = j.res.playlist.length - 1;
    advance();
  });
}

export function enqueue(j: Job) {
  const { jobs } = now;
  // In a background tab (the user switched away from the call; listening goes on) Chrome may pause muted video:
  // keep just the newest phrase and sign it when the tab is visible again.
  if (document.hidden) { jobs.length = 0; jobs.push(j); return; }
  // Live speech: never fall far behind. Drop whole not-yet-started phrases beyond ~8 s of backlog.
  while (jobs.length && backlog() > 8) jobs.shift();
  jobs.push(j);
  if (!now.job && !now.holdTimer) advance();
  else if (!swapping) {
    const next = peek();
    if (next) load(vids[1 - front]!, next.url);
  }
}

export function clearVideo() {
  now.jobs.length = 0;
  now.job = null;
  now.idx = -1;
  stopVideo();
}
/** Never a stale clip under a caption: both videos stop and drop their source. */
function stopVideo() {
  gen3d++;
  stop3d();
  front = 0;
  swapToken++;
  swapping = false;
  vids.forEach((v) => { v.pause(); v.removeAttribute("src"); delete v.dataset.url; v.load(); v.classList.remove("on", "top"); });
}

/** Idle: the signer waits in the neutral pose (first frame of a clip), also painted into the still behind the videos. */
let neutralId: string | null = null;
let stillDone = false;
export async function showNeutral() {
  if (now.job || vids[front]!.dataset.url) return;
  try {
    neutralId ??= (await client.vocab()).signs[0]?.motion_id ?? null;
    if (!neutralId || now.job || vids[front]!.dataset.url) return;
    const v = vids[front]!;
    load(v, `${client.base}${ROUTES.clips}${neutralId}.mp4`);
    v.addEventListener("loadeddata", () => {
      paintStill(v);
      if (!now.job) v.classList.add("on");
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
/** The server changed: its neutral clip and still are fetched again. */
export function resetNeutral() { neutralId = null; stillDone = false; }

export function initPlayer() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (now.job) { const rest = now.jobs.slice(); clearVideo(); now.jobs.push(...rest.slice(-1)); renderCaptions(); render(); }
    } else if (!now.job && !now.holdTimer && now.jobs.length) advance();
  });
  vids.forEach((v) => {
    v.addEventListener("ended", () => v === vids[front] && now.job && advance());
    v.addEventListener("error", () => {
      if (v === vids[front] && now.job && v.getAttribute("src")) { console.warn("[flux] clip failed", v.src); advance(); }
    });
  });
}
