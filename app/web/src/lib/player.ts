// Gapless playlist player: two stacked <video> elements. While one plays, the next clip preloads in the other.
// A frame callback watches the playing clip and starts the preloaded one ~one crossfade before the end; the new
// clip is brought to the front on its first presented frame and fades in over the old one (which stays opaque
// underneath, holding its last frame), so there is never a black frame, a flash or a freeze at the seam. Every
// clip starts and ends in the same neutral pose, so the short overlap is imperceptible.
// New phrases append to the running queue; if playback had drained it resumes at the new items.

export interface PlayerItem { url: string; duration_s: number }

// Clips are small (~0.5 MB). Fetching each once into a blob: URL makes the swap instant and avoids media
// elements holding HTTP connections open (which stalled the next clip for seconds in testing).
const blobs = new Map<string, Promise<string | null>>();
const ready = new Map<string, string>();
export function prefetchClip(url: string): Promise<string | null> {
  let p = blobs.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => { const u = URL.createObjectURL(b); ready.set(url, u); return u; })
      .catch(() => { blobs.delete(url); return null; });
    blobs.set(url, p);
  }
  return p;
}

/** Crossfade between clips (ms). Long enough to hide a seam, short enough to never read as a dissolve. */
export const SEAM_MS = 110;
/** The very first clip fades up from the empty stage a little more slowly. */
const REVEAL_MS = 360;

type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number; cancelVideoFrameCallback?: (h: number) => void };

export class GaplessPlayer {
  private items: PlayerItem[] = [];
  private loaded: [number, number] = [-1, -1];
  private front = 0;
  private index = -1;
  private draining = false; // played everything, waiting for more
  private pending = -1; // index we asked to play and are waiting on
  private disposed = false;
  private readonly offs: (() => void)[] = [];
  private fadeTimer = 0;
  private readonly seamMs: number;

  /** Called with the playlist index now on screen; items.length once the queue has drained. */
  onIndex: (index: number) => void = () => {};

  constructor(private readonly vids: [HTMLVideoElement, HTMLVideoElement]) {
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.seamMs = reduce ? 0 : SEAM_MS;
    vids.forEach((v, slot) => {
      v.style.opacity = "0";
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.setAttribute("playsinline", "");
      v.setAttribute("muted", "");
      const ended = () => slot === this.front && this.pending < 0 && this.next();
      const failed = () => {
        // A clip that can't load is skipped, never left frozen.
        if (this.pending >= 0 && this.loaded[slot] === this.pending) { this.index = this.pending; this.pending = -1; this.next(); }
        else if (slot === this.front && this.pending < 0 && this.index >= 0 && this.index < this.items.length) this.next();
      };
      v.addEventListener("ended", ended);
      v.addEventListener("error", failed);
      this.offs.push(() => { v.removeEventListener("ended", ended); v.removeEventListener("error", failed); });
    });
  }

  get length() { return this.items.length; }
  get current() { return this.index; }

  append(items: PlayerItem[]) {
    if (this.disposed || !items.length) return;
    this.items.push(...items);
    items.forEach((x) => void prefetchClip(x.url));
    if (this.index < 0 && this.pending < 0) this.playAt(0);
    else if (this.draining) this.playAt(this.items.length - items.length);
    else this.preloadNext();
  }

  replay() {
    if (!this.items.length) return;
    this.pending = -1;
    this.draining = false;
    this.vids.forEach((v) => v.pause());
    // Load clip 0 behind the visible frame, then swap as usual.
    const back = 1 - this.front;
    this.loaded = [-1, -1];
    this.index = -1;
    this.onIndex(-1);
    this.load(back, 0);
    this.playAt(0);
  }

  stop() {
    this.pending = -1;
    clearTimeout(this.fadeTimer);
    this.vids.forEach((v) => v.pause());
  }

  /** Discard a previous message when safety blocks playback or the API fails. */
  clear() {
    this.stop();
    this.items = [];
    this.loaded = [-1, -1];
    this.index = -1;
    this.front = 0;
    this.draining = false;
    this.vids.forEach((v) => { v.removeAttribute("src"); v.load(); v.classList.remove("front", "back"); v.style.transition = "none"; v.style.opacity = "0"; v.style.zIndex = ""; });
    this.onIndex(-1);
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.offs.forEach((f) => f());
    this.vids.forEach((v) => { v.removeAttribute("src"); v.load(); });
  }

  private load(slot: number, i: number) {
    const v = this.vids[slot]!;
    const url = this.items[i]!.url;
    v.src = ready.get(url) ?? url;
    v.load();
    this.loaded[slot] = i;
    if (!ready.has(url)) {
      // Not fetched yet: switch to the blob as soon as it lands, if this slot is still only preloading it.
      void prefetchClip(url).then((u) => {
        if (u && this.loaded[slot] === i && slot !== this.front && this.pending !== i && v.src === url) { v.src = u; v.load(); }
      });
    }
  }

  private preloadNext() {
    const n = this.index + 1, back = 1 - this.front;
    if (n < this.items.length && this.loaded[back] !== n && this.pending < 0) this.load(back, n);
  }

  private next() {
    const n = this.index + 1;
    if (n < this.items.length) this.playAt(n);
    else { this.draining = true; this.index = this.items.length; this.onIndex(this.index); }
  }

  /** Bring `v` up over `under`. `under` stays opaque (holding its last frame) until `v` fully covers it. */
  private crossfade(v: HTMLVideoElement, under: HTMLVideoElement) {
    clearTimeout(this.fadeTimer);
    const covered = under.style.opacity === "1" && under.readyState >= 2;
    const ms = this.seamMs === 0 ? 0 : covered ? this.seamMs : REVEAL_MS;
    v.style.zIndex = "2";
    under.style.zIndex = "1";
    v.style.transition = "none";
    v.style.opacity = ms ? "0" : "1";
    if (ms) {
      void v.offsetWidth; // commit opacity 0 before animating
      v.style.transition = `opacity ${ms}ms linear`;
      v.style.opacity = "1";
    }
    this.fadeTimer = window.setTimeout(() => { if (this.vids[this.front] === v) under.pause(); }, ms + 60);
  }

  /** Watch the clip on screen frame by frame; start the next one a crossfade before this one ends. */
  private watch(slot: number, i: number) {
    const v = this.vids[slot] as FrameVideo;
    const rvfc = v.requestVideoFrameCallback;
    if (!rvfc || this.seamMs === 0) return; // `ended` still advances the queue
    const lead = this.seamMs / 1000 + 0.02;
    const check = (_now: number, meta: { mediaTime: number }) => {
      if (this.disposed || this.front !== slot || this.index !== i || this.pending >= 0) return;
      const n = i + 1, d = v.duration;
      if (n < this.items.length && Number.isFinite(d) && d > 0 && meta.mediaTime >= d - lead) {
        const back = 1 - slot;
        if (this.loaded[back] === n && this.vids[back]!.readyState >= 3) { this.playAt(n); return; }
      }
      if (!v.paused && !v.ended) rvfc.call(v, check);
    };
    rvfc.call(v, check);
  }

  private playAt(i: number) {
    if (this.disposed) return;
    this.draining = false;
    let slot = this.loaded.indexOf(i);
    if (slot < 0 || slot === this.front && this.index >= 0 && this.index !== i) {
      slot = this.index < 0 && (this.loaded[this.front] ?? -1) < 0 ? this.front : 1 - this.front;
      this.load(slot, i);
    }
    const v = this.vids[slot]!;
    if (v.currentTime > 0) v.currentTime = 0;
    this.pending = i;
    const show = () => {
      if (this.disposed || this.pending !== i) return;
      this.pending = -1;
      const other = this.vids[1 - slot]!;
      v.classList.add("front"); v.classList.remove("back");
      other.classList.remove("front"); other.classList.add("back");
      this.crossfade(v, other);
      this.front = slot;
      this.index = i;
      this.onIndex(i);
      this.preloadNext();
      this.watch(slot, i);
    };
    const rvfc = (v as FrameVideo).requestVideoFrameCallback;
    if (rvfc) rvfc.call(v, show); // swap on the first presented frame
    v.addEventListener("playing", () => setTimeout(show, 0), { once: true });
    v.play().catch(() => {
      // Autoplay refused or source failed: skip ahead rather than hang.
      if (this.pending === i) { this.pending = -1; this.index = i; this.next(); }
    });
  }
}
