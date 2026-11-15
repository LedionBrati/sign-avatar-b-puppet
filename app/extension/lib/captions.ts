// Caption sources inside the page (content script). Three, best first:
//
//  1. YouTube transcript: the watch page's own "Show transcript" panel, opened off-screen once per video, read
//     (timestamped, human-segmented lines) and closed again. Lines are then sent in sync with video.currentTime,
//     with the next line attached so the signer can fetch it ahead of time. Works whether or not CC is on.
//  2. YouTube on-screen captions (CC): a MutationObserver on the player's caption container (.ytp-caption-segment
//     inside .caption-visual-line), assembled into phrases (lib/phrases.ts). Live streams and videos without a
//     transcript use this.
//  3. Any other site: <video> text tracks (WebVTT <track> / players that use TextTrack), via cuechange.
//
// It handles YouTube's SPA navigation (yt-navigate-finish + URL polling), ads (.ad-showing), pause and seeking.

import type { Origin, SourceState } from "./messages";
import { PhraseAssembler, cueAt, cuesFromTranscript, parseClock, stripAnnotations, type Cue } from "./phrases";

export interface CaptionSink {
  phrase(text: string, origin: Origin, next?: string): void;
  state(s: SourceState): void;
  /** Seek / new video: drop anything queued in the signer. */
  reset(): void;
}

const LEAD_S = 0.3; // send a transcript line this much before it is spoken (the signer needs a moment to start)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isYouTube = () => /(^|\.)youtube\.com$/.test(location.hostname);
const youTubeVideoId = () => {
  if (!isYouTube()) return null;
  const u = new URL(location.href);
  if (u.pathname === "/watch") return u.searchParams.get("v");
  const m = /^\/(?:live|embed)\/([\w-]{6,})/.exec(u.pathname);
  return m?.[1] ?? null;
};
const player = () => document.querySelector<HTMLElement>("#movie_player, .html5-video-player");
const mainVideo = () => document.querySelector<HTMLVideoElement>("#movie_player video.html5-main-video, .html5-video-player video") ?? document.querySelector("video");
const adShowing = () => !!player()?.classList.contains("ad-showing");

/** Is there something here the caption watcher can follow? (decides whether the signer shows up on its own) */
export function hasCaptionSource() {
  if (youTubeVideoId()) return true;
  return [...document.querySelectorAll("video")].some((v) => [...v.textTracks].some((t) => t.kind === "captions" || t.kind === "subtitles"));
}

// ── 1. YouTube transcript panel ────────────────────────────────────────────────────────────────────────────

const PANEL = "ytd-engagement-panel-section-list-renderer";
const EXPANDED = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
const SEGMENTS = "transcript-segment-view-model, ytd-transcript-segment-renderer";

function readSegments(): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  document.querySelectorAll<HTMLElement>(SEGMENTS).forEach((el) => {
    const ts = el.querySelector(".ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp")?.textContent ?? "";
    const txt = el.querySelector(".ytAttributedStringHost, [role=text], .segment-text, yt-formatted-string.segment-text")?.textContent ?? "";
    let start = parseClock(ts);
    let text = txt;
    if (!Number.isFinite(start) || !text) {
      // Fallback for markup changes: "0:12 12 seconds So in college…"
      const m = /^\s*(\d+(?::\d{2})+)\s*(?:\d+\s+\w+(?:,\s*\d+\s+\w+)*\s+)?(.*)$/s.exec(el.textContent ?? "");
      if (!m) return;
      start = parseClock(m[1]!);
      text = m[2]!;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (Number.isFinite(start) && text) out.push({ start, text });
  });
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Open the transcript panel off-screen, read it, close it. null if this video has no transcript. */
async function harvestTranscript(videoId: string): Promise<Cue[] | null> {
  let button: HTMLElement | null = null;
  for (let i = 0; i < 40 && !button; i++) {
    if (youTubeVideoId() !== videoId) return null;
    button = document.querySelector<HTMLElement>("ytd-video-description-transcript-section-renderer button");
    if (!button) await sleep(250);
  }
  // A transcript panel the user already has open: just read it.
  const already = readSegments();
  if (already.length > 2) return cuesFromTranscript(already);
  if (!button) return null;

  const before = new Set([...document.querySelectorAll(`${PANEL}[visibility="${EXPANDED}"]`)]);
  const style = document.createElement("style");
  style.textContent = `html[data-sl-harvest] ${PANEL}[visibility="${EXPANDED}"]:not([data-sl-keep]), ${PANEL}[data-sl-hidden] {
    position: fixed !important; left: -10000px !important; top: 0 !important; visibility: hidden !important; pointer-events: none !important; }`;
  before.forEach((p) => p.setAttribute("data-sl-keep", ""));
  document.documentElement.setAttribute("data-sl-harvest", "");
  document.head.append(style);
  const scroll = [scrollX, scrollY] as const;
  try {
    button.click();
    let segs: { start: number; text: string }[] = [];
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      segs = readSegments();
      if (segs.length) {
        await sleep(250); // let the list finish rendering
        segs = readSegments();
        break;
      }
    }
    return segs.length ? cuesFromTranscript(segs) : null;
  } finally {
    // Close what we opened (its own close button); anything that will not close stays hidden until the user opens it.
    const opened = [...document.querySelectorAll<HTMLElement>(`${PANEL}[visibility="${EXPANDED}"]`)].filter((p) => !before.has(p));
    for (const p of opened) {
      const close = [...p.querySelectorAll<HTMLElement>("button")].find((b) => /close/i.test(b.getAttribute("aria-label") ?? ""))
        ?? p.querySelector<HTMLElement>("#visibility-button button");
      close?.click();
    }
    await sleep(200);
    for (const p of opened) if (p.getAttribute("visibility") === EXPANDED) p.setAttribute("data-sl-hidden", "");
    before.forEach((p) => p.removeAttribute("data-sl-keep"));
    document.documentElement.removeAttribute("data-sl-harvest");
    scrollTo(scroll[0], scroll[1]);
    // The user asking for the transcript themselves gets it back.
    button.addEventListener("click", () => document.querySelectorAll(`${PANEL}[data-sl-hidden]`).forEach((p) => p.removeAttribute("data-sl-hidden")), { once: true });
    if (!document.querySelector(`${PANEL}[data-sl-hidden]`)) style.remove();
  }
}

// ── The watcher ──────────────────────────────────────────────────────────────────────────────────────────

export function startCaptionWatch(sink: CaptionSink): () => void {
  let stopped = false;
  let videoKey: string | null = null;
  let cues: Cue[] | null = null;
  let last = -1, lastT = 0;
  let lastState = "";
  const timers: number[] = [];
  const state = (s: SourceState) => {
    const k = JSON.stringify(s);
    if (k !== lastState) { lastState = k; sink.state(s); }
  };

  // On-screen captions (CC) -> phrases.
  const asm = new PhraseAssembler((text) => {
    if (!cues) sink.phrase(text, "captions");
  });
  let observed: Element | null = null;
  const mo = new MutationObserver(() => readCaptionDom());
  function readCaptionDom() {
    const lines = [...document.querySelectorAll<HTMLElement>(".caption-window .caption-visual-line")];
    const segs = lines.length ? lines : [...document.querySelectorAll<HTMLElement>(".ytp-caption-segment")];
    const text = segs.map((el) => el.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (text && !adShowing()) asm.update(text);
  }
  function observeCaptions() {
    const box = document.querySelector(".ytp-caption-window-container") ?? player();
    if (!box || box === observed) return;
    mo.disconnect();
    mo.observe(box, { childList: true, subtree: true, characterData: true });
    observed = box;
  }

  // Generic <video> text tracks.
  const trackSeen = new WeakSet<TextTrack>();
  let lastCue = "";
  function watchTextTracks() {
    if (isYouTube()) return;
    document.querySelectorAll("video").forEach((v) => {
      for (const t of v.textTracks) {
        if ((t.kind !== "captions" && t.kind !== "subtitles") || trackSeen.has(t)) continue;
        trackSeen.add(t);
        if (t.mode === "disabled") t.mode = "hidden"; // cues fire without showing anything extra
        t.addEventListener("cuechange", () => {
          const text = stripAnnotations([...(t.activeCues ?? [])].map((c) => (c as VTTCue).text ?? "").join(" ").replace(/<[^>]+>/g, ""));
          if (text && text !== lastCue) { lastCue = text; sink.phrase(text, "texttrack"); }
        });
        state({ kind: "listening", origin: "texttrack" });
      }
    });
  }

  async function onVideo() {
    const id = youTubeVideoId();
    const key = id ?? (isYouTube() ? null : "page");
    if (key === videoKey) return;
    videoKey = key;
    cues = null;
    last = -1;
    asm.reset();
    sink.reset();
    if (!id) {
      state({ kind: "idle" });
      return;
    }
    state({ kind: "listening", origin: "captions" });
    const got = await harvestTranscript(id).catch(() => null);
    if (stopped || youTubeVideoId() !== id) return;
    cues = got;
    if (cues) state({ kind: "listening", origin: "transcript" });
  }

  function tick() {
    if (stopped) return;
    asm.tick();
    if (!youTubeVideoId()) return;
    observeCaptions();
    const v = mainVideo();
    if (!v) return;
    if (adShowing()) return state({ kind: "ad" });
    if (cues) {
      if (v.paused) return state({ kind: "paused", origin: "transcript" });
      state({ kind: "listening", origin: "transcript", rate: v.playbackRate });
      const t = v.currentTime;
      const i = cueAt(cues, t + LEAD_S);
      const seeked = t < lastT - 1 || t > lastT + 3;
      lastT = t;
      if (i === last) return;
      if (seeked || i < last || i - last > 3) {
        sink.reset();
        last = i;
        // Mid-line after a seek: sign it only if it has only just started.
        if (i >= 0 && t - cues[i]!.start < 1.5) sink.phrase(cues[i]!.text, "transcript", cues[i + 1]?.text);
        return;
      }
      last = i;
      if (i >= 0) sink.phrase(cues[i]!.text, "transcript", cues[i + 1]?.text);
    } else {
      const cc = document.querySelector(".ytp-subtitles-button")?.getAttribute("aria-pressed");
      if (cc === "false") state({ kind: "need-cc" });
      else if (v.paused) state({ kind: "paused", origin: "captions" });
      else state({ kind: "listening", origin: "captions", rate: v.playbackRate });
    }
  }

  const nav = () => { onVideo(); };
  addEventListener("yt-navigate-finish", nav);
  let href = location.href;
  timers.push(window.setInterval(() => {
    if (location.href !== href) { href = location.href; onVideo(); }
    watchTextTracks();
  }, 700));
  timers.push(window.setInterval(tick, 200));
  onVideo();
  watchTextTracks();

  return () => {
    stopped = true;
    removeEventListener("yt-navigate-finish", nav);
    timers.forEach(clearInterval);
    mo.disconnect();
  };
}
