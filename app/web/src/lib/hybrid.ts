// One session queue over two signers: the photoreal clip player (GaplessPlayer) and the instant 3D signer
// (Signer3D, app/core). Each phrase plays whole in one style (choosePlayback in app/core decides); consecutive clip
// phrases share one gapless run, each 3D phrase is one run (rest -> signs -> rest). Indexes are global over the session,
// like GaplessPlayer's, so Live's phrase offsets and captions work the same in both modes.
// The stage crossfades between the styles: onMode("3d") once the 3D signer draws its first frame, onMode("clips")
// when the first clip of a clip run is on screen.
import type { PlaylistItem, Signer3D } from "@flux/core";
import type { GaplessPlayer } from "./player";

export type StageMode = "clips" | "3d";
interface Run { mode: StageMode; start: number; items: PlaylistItem[]; rest?: string; gBase: number; done: boolean }

export class HybridPlayer {
  private runs: Run[] = [];
  private active = -1;
  private total = 0;
  private idle = true;
  private mode: StageMode = "clips";
  /** Global playlist index on screen; length once everything has played (like GaplessPlayer.onIndex). */
  onIndex: (index: number) => void = () => {};
  /** The style on stage changed. */
  onMode: (mode: StageMode) => void = () => {};
  /** The 3D signer is loading (first use: player bundle + avatar). */
  onLoading: (loading: boolean) => void = () => {};

  private readonly clips: GaplessPlayer;
  private readonly signer3d: () => Signer3D;

  constructor(clips: GaplessPlayer, signer3d: () => Signer3D) {
    this.clips = clips;
    this.signer3d = signer3d;
    clips.onIndex = (i) => this.fromClips(i);
  }

  get length() { return this.total; }

  append(items: PlaylistItem[], mode: StageMode, rest?: string) {
    if (!items.length) return;
    const last = this.runs.at(-1);
    if (mode === "clips" && last?.mode === "clips" && !last.done) {
      last.items.push(...items);
      if (this.runs[this.active] === last) this.clips.append(items.map(toClip));   // the clip run playing now: stay gapless
    } else {
      this.runs.push({ mode, start: this.total, items: [...items], rest, gBase: 0, done: false });
      if (mode === "3d") this.signer3d().prefetch(items, rest);
    }
    this.total += items.length;
    if (this.idle) this.next();
  }

  replay() {
    if (!this.runs.length) return;
    this.signer3d().stop();
    this.runs.forEach((r) => (r.done = false));
    this.idle = false;
    if (this.runs.length === 1 && this.runs[0]!.mode === "clips") { this.active = 0; this.clips.replay(); return; }  // as before
    this.clips.clear();
    this.active = -1;
    this.onIndex(-1);
    this.next();
  }

  /** Stop now; phrases that arrive later still play. */
  stop() {
    this.clips.stop();
    this.signer3d().stop();
    this.runs.forEach((r) => (r.done = true));
    this.active = this.runs.length - 1;
    this.idle = true;
    this.onLoading(false);
  }

  clear() {
    this.signer3d().stop();
    this.clips.clear();
    this.runs = [];
    this.total = 0;
    this.active = -1;
    this.idle = true;
    this.onLoading(false);
    this.setMode("clips");
    this.onIndex(-1);
  }

  dispose() { this.signer3d().stop(); }

  private setMode(m: StageMode) {
    if (m === this.mode) return;
    this.mode = m;
    this.onMode(m);
  }

  private next() {
    const r = this.active + 1;
    const run = this.runs[r];
    if (!run) { this.idle = true; this.onIndex(this.total); return; }
    this.active = r;
    this.idle = false;
    if (run.mode === "clips") {
      run.gBase = this.clips.length;
      this.clips.append(run.items.map(toClip));
    } else this.play3d(run);
  }

  private fromClips(i: number) {
    const run = this.runs[this.active];
    if (!run || run.mode !== "clips" || run.done || i < 0) return;
    if (i >= this.clips.length) { run.done = true; this.next(); return; }
    const local = i - run.gBase;
    if (local < 0 || local >= run.items.length) return;
    this.setMode("clips");
    this.onIndex(run.start + local);
  }

  private play3d(run: Run) {
    const s = this.signer3d();
    if (!s.ready) this.onLoading(true);
    const mine = () => this.runs[this.active] === run && !run.done;
    s.play(run.items, {
      restUrl: run.rest,
      onIndex: (k) => {
        if (!mine()) return;
        this.onLoading(false);
        this.setMode("3d");
        if (k >= 0) this.onIndex(run.start + k);
      },
    }).then((finished) => {
      if (!finished || !mine()) return;
      run.done = true;
      this.next();
    }).catch(() => {
      if (!mine()) return;
      this.onLoading(false);
      // The 3D signer could not load (network, WebGL): a phrase that has every clip still plays photoreal.
      if (run.items.every((x) => x.url)) { run.mode = "clips"; this.active--; this.next(); return; }
      run.done = true;
      this.next();
    });
  }
}

const toClip = (x: PlaylistItem) => ({ url: x.url, duration_s: x.duration_s });
