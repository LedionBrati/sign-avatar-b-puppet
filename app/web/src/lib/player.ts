// Gapless playlist player: two stacked <video> elements. While one plays, the next clip preloads in the other;
// on `ended` the preloaded one starts and is brought to the front only once it is actually playing, so the
// last frame of the old clip covers any decode gap (every clip starts and ends in the same neutral pose).
// New phrases append to the running queue; if playback had drained it resumes at the new items.

export interface PlayerItem { url: string; duration_s: number }

export class GaplessPlayer {
  private items: PlayerItem[] = [];
  private loaded: [number, number] = [-1, -1];
  private front = 0;
  private index = -1;
  private draining = false; // played everything, waiting for more
  private pending = -1; // index we asked to play and are waiting on
  private disposed = false;
  private readonly offs: (() => void)[] = [];

  /** Called with the playlist index now on screen; items.length once the queue has drained. */
  onIndex: (index: number) => void = () => {};

  constructor(private readonly vids: [HTMLVideoElement, HTMLVideoElement]) {
    vids.forEach((v, slot) => {
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
    this.vids.forEach((v) => v.pause());
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.offs.forEach((f) => f());
    this.vids.forEach((v) => { v.removeAttribute("src"); v.load(); });
  }

  private load(slot: number, i: number) {
    const v = this.vids[slot]!;
    v.src = this.items[i]!.url;
    v.load();
    this.loaded[slot] = i;
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
      other.pause();
      this.front = slot;
      this.index = i;
      this.onIndex(i);
      this.preloadNext();
    };
    const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
    if (rvfc) rvfc.call(v, show); // swap on the first presented frame
    v.addEventListener("playing", () => setTimeout(show, 0), { once: true });
    v.play().catch(() => {
      // Autoplay refused or source failed: skip ahead rather than hang.
      if (this.pending === i) { this.pending = -1; this.index = i; this.next(); }
    });
  }
}
