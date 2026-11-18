// The instant 3D signer, shared by web and extension: the playback rule, the slim-motion inflater, and a small engine
// that plays a phrase on puppet/src/player.ts (SignerPlayer) and reports which playlist item is being signed.
//
// Playback rule (one style per phrase, never mixed):
//   every sign has a photoreal clip            -> "clips": the photoreal playlist, as before
//   otherwise, every sign has motion           -> "3d": the WHOLE phrase on the 3D signer
//   "Always 3D" (a setting) and every sign has motion -> "3d"
//   anything else (or an empty playlist)       -> "none": captions only
// Words with neither clip nor motion never reach the playlist: the server's safety gate keeps such a phrase
// caption-only, and fingerspells a name only when every letter has a clip (or, for 3D, a motion).

import type { PlaylistItem, SignResponse } from "./api";

export type PlaybackMode = "clips" | "3d" | "none";

export function choosePlayback(res: Pick<SignResponse, "playlist">, { always3d = false }: { always3d?: boolean } = {}): PlaybackMode {
  const pl = res.playlist;
  if (!pl.length) return "none";
  const allMotion = pl.every((p) => !!p.motion_url);
  const allClips = pl.every((p) => !!p.url);
  if (always3d && allMotion) return "3d";
  if (allClips) return "clips";
  if (allMotion) return "3d";
  return "none";
}

/** Face mesh size the player expects (MediaPipe 468 + 10 iris). */
const FACE_POINTS = 478;

/**
 * Undo the server's slim transport (app/server/lib/motions.mjs): `face_subset` lists the MediaPipe indices each
 * frame's short `face` holds; put them back in a 478-point face (the other points copy the nose tip: the player only
 * reads the listed ones when the frame has blendshapes, which the server checks before slimming). Mutates and returns m.
 */
export function inflateMotion<T>(m: T): T {
  const x = m as unknown as { face_subset?: number[]; frames?: { face?: number[][] | null }[] };
  const subset = x?.face_subset;
  if (!Array.isArray(subset) || !Array.isArray(x.frames)) return m;
  const nose = Math.max(0, subset.indexOf(1));
  for (const f of x.frames) {
    const face = f.face;
    if (!Array.isArray(face) || face.length !== subset.length) continue;
    const full: number[][] = new Array(FACE_POINTS);
    const fill = face[nose]!;
    for (let k = 0; k < FACE_POINTS; k++) full[k] = fill;
    subset.forEach((idx, k) => { if (idx >= 0 && idx < FACE_POINTS) full[idx] = face[k]!; });
    f.face = full;
  }
  delete x.face_subset;
  return m;
}

/** What Signer3D needs from puppet/src/player.ts SignerPlayer (structural, so app/core has no three.js dependency). */
export interface SignerPlayerLike {
  loadSentence(motions: unknown[], blendS?: number): { frames: number; fps: number; segments: { start: number; end: number; gloss: string | null }[] | null };
  play(opts?: { onFrame?: (frame: number, sign: string | null) => void }): Promise<void>;
  stop(): void;
  seek(frame: number): void;
}
export interface SignerPlayerModule {
  SignerPlayer: { create(canvas: HTMLCanvasElement, opts?: { modelUrl?: string }): Promise<SignerPlayerLike> };
}

/** The 3D signer's canvas: 3:4 like the photoreal clips. */
export const SIGNER3D_SIZE = { width: 540, height: 720 } as const;

export interface Signer3DOptions {
  /** Lazy loader of the player bundle, e.g. () => import("@flux/signer-player"). Called once. */
  load: () => Promise<SignerPlayerModule>;
  /** The avatar, e.g. client.modelUrl() (GET /models/signer.glb). Fetched once. */
  modelUrl: string;
  /** Default: a new SIGNER3D_SIZE canvas (put it on the page yourself). */
  canvas?: HTMLCanvasElement;
  /** Cross-blend between neighbouring signs, seconds (default 0.2). */
  blendS?: number;
  fetch?: typeof fetch;
}

/**
 * One warm 3D signer on one canvas. warm() loads the bundle + avatar once (later calls share the promise; a failure
 * clears it so the next call retries). Motion files are fetched once per URL and kept. play() signs one phrase:
 * rest pose -> signs (blended) -> rest pose, calling onIndex(i) as playlist item i comes up. A newer play() or stop()
 * cancels the current one (its promise resolves false).
 */
export class Signer3D {
  readonly canvas: HTMLCanvasElement;
  private player: Promise<SignerPlayerLike> | null = null;
  private readonly motions = new Map<string, Promise<unknown>>();
  private gen = 0;
  private restShown = false;
  /** Set once the avatar is on screen. */
  ready = false;

  private readonly o: Signer3DOptions;

  constructor(o: Signer3DOptions) {
    this.o = o;
    this.canvas = o.canvas ?? Object.assign(document.createElement("canvas"), SIGNER3D_SIZE);
  }

  warm(restUrl?: string): Promise<SignerPlayerLike> {
    if (!this.player) {
      this.player = this.o.load()
        .then((mod) => mod.SignerPlayer.create(this.canvas, { modelUrl: this.o.modelUrl }))
        .then((p) => { this.ready = true; return p; });
      this.player.catch(() => { this.player = null; });
    }
    const p = this.player;
    if (restUrl && !this.restShown) {
      // Stand in the rest pose until the first phrase (instead of the model's bind pose).
      void Promise.all([p, this.motion(restUrl)]).then(([pl, rest]) => {
        if (this.restShown) return;
        this.restShown = true;
        pl.loadSentence([rest]);
        pl.seek(0);
      }).catch(() => {});
    }
    return p;
  }

  /** A motion file, fetched and inflated once. */
  motion(url: string): Promise<unknown> {
    let p = this.motions.get(url);
    if (!p) {
      const f = this.o.fetch ?? fetch;
      p = f(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`motion ${url}: HTTP ${r.status}`)))).then((m) => inflateMotion(m));
      p.catch(() => this.motions.delete(url));
      this.motions.set(url, p);
    }
    return p;
  }

  /** Start fetching a phrase's motions (while the card forms or the previous phrase plays). */
  prefetch(items: Pick<PlaylistItem, "motion_url">[], restUrl?: string) {
    for (const i of items) if (i.motion_url) void this.motion(i.motion_url).catch(() => {});
    if (restUrl) void this.motion(restUrl).catch(() => {});
  }

  /** Sign one phrase. Resolves true when it played to the end, false when stopped or replaced. Throws if it can't load. */
  async play(items: Pick<PlaylistItem, "motion_url">[], { restUrl, onIndex }: { restUrl?: string; onIndex?: (i: number) => void } = {}): Promise<boolean> {
    const g = ++this.gen;
    if (!items.length || items.some((i) => !i.motion_url)) throw new Error("every sign needs a motion_url");
    const [player, motions, rest] = await Promise.all([
      this.warm(),
      Promise.all(items.map((i) => this.motion(i.motion_url!))),
      restUrl ? this.motion(restUrl).catch(() => null) : Promise.resolve(null),
    ]);
    if (g !== this.gen) return false;
    this.restShown = true;
    const list = rest ? [rest, ...motions, rest] : motions;
    const info = player.loadSentence(list, this.o.blendS ?? 0.2);
    const starts = (info.segments ?? []).map((s) => s.start);
    const first = rest ? 1 : 0;
    let cur = -2;
    const at = (frame: number) => {
      let idx = -1;
      for (let k = 0; k < items.length; k++) if (frame >= (starts[k + first] ?? Infinity)) idx = k;
      return idx;
    };
    await player.play({
      onFrame: (frame) => {
        if (g !== this.gen) return;
        const i = at(frame);
        if (i !== cur) { cur = i; onIndex?.(i); }
      },
    });
    return g === this.gen;
  }

  stop() {
    this.gen++;
    void this.player?.then((p) => p.stop()).catch(() => {});
  }
}
