// Instant in-browser signer: the realistic avatar (puppet/models/signer.glb) plays a motion, or a sentence of
// sign motions joined on the fly, on a <canvas>. No server, no video: solve + clean-up once (bake), then draw
// every screen refresh. This is the module for app/web; nothing here touches the DOM beyond the canvas.
//
//   import { SignerPlayer } from "puppet/src/player";        // or the bundle: puppet/dist/signer-player.js
//   const player = await SignerPlayer.create(canvas, { modelUrl: "/models/signer.glb" });
//   await player.playSentence([helloMotion, youMotion]);    // motion files (FORMAT.md v1 or v2), blended 0.2 s
//
// Defaults: anatomic hands (src/hand.ts), soft light, the target photo's framing and wall. A v2 motion's
// `hands3d` is used for the fingers when present.

import { VrmPuppet, type Pass, type Solver } from "./vrm";
import { validateMotion, type Motion } from "./motion";
import { concatClips, type Segment } from "./blend";

export interface PlayerOptions {
  /** avatar file: signer.glb (default "/models/signer.glb") or any .vrm */
  modelUrl?: string;
  /** drawing size in pixels (default: the canvas size, else 540x720) */
  width?: number;
  height?: number;
  solver?: Solver;
  /** e.g. ["rgb", "depth"] to show passes side by side (default rgb only) */
  passes?: Pass[];
  background?: string;
  /** multisampling (default true) */
  antialias?: boolean;
}

export interface PlayOptions {
  loop?: boolean;
  /** playback speed (default 1) */
  rate?: number;
  /** called once per drawn frame with the motion frame index and the sign playing (sentences) */
  onFrame?: (frame: number, sign: string | null) => void;
}

export interface Loaded {
  frames: number;
  fps: number;
  seconds: number;
  /** time to solve and clean the whole motion, ms (what a user waits before the first frame) */
  bakeMs: number;
  segments: Segment[] | null;
}

export class SignerPlayer {
  readonly puppet: VrmPuppet;
  private motion: Motion | null = null;
  private segments: Segment[] | null = null;
  private raf = 0;
  private t0 = 0;
  private startFrame = 0;
  private resolveEnd: (() => void) | null = null;
  /** current (fractional) motion frame */
  frame = 0;

  private constructor(puppet: VrmPuppet) { this.puppet = puppet; }

  static async create(canvas: HTMLCanvasElement, opts: PlayerOptions = {}): Promise<SignerPlayer> {
    const w = opts.width ?? (canvas.width || 540), h = opts.height ?? (canvas.height || 720);
    const model = opts.modelUrl ?? "/models/signer.glb";
    const solver = opts.solver ?? (/\.(glb|gltf)(\?|$)/i.test(model) ? "anatomic" : "direct");
    const puppet = new VrmPuppet(canvas, w, h, { solver, passes: opts.passes, background: opts.background, antialias: opts.antialias });
    await puppet.load(model);
    puppet.render();
    return new SignerPlayer(puppet);
  }

  /** Bake one motion (a parsed motion file, v1 or v2). Throws on an invalid file. */
  load(motion: unknown, segments: Segment[] | null = null): Loaded {
    const { motion: m } = validateMotion(motion);
    const t = performance.now();
    this.puppet.bake(m);
    const bakeMs = performance.now() - t;
    this.motion = m;
    this.segments = segments;
    this.seek(0);
    return { frames: m.frames.length, fps: m.fps, seconds: m.frames.length / m.fps, bakeMs, segments };
  }

  /** Join sign motions into one sentence (src/blend.ts: per-sign cross-blend), bake it. */
  loadSentence(motions: unknown[], blendS = 0.2): Loaded {
    const clips = motions.map((x) => ({ motion: validateMotion(x).motion }));
    const { motion, segments } = concatClips(clips, { blend: blendS, fps: clips[0]?.motion.fps ?? 24 });
    return this.load(motion, segments);
  }

  /** Play from the current frame; resolves when it reaches the end (never, with loop). */
  play(opts: PlayOptions = {}): Promise<void> {
    if (!this.motion) return Promise.resolve();
    this.stop();
    const m = this.motion, rate = opts.rate ?? 1, n = m.frames.length;
    this.t0 = performance.now();
    this.startFrame = this.frame >= n - 1 ? 0 : this.frame;
    return new Promise<void>((resolve) => {
      this.resolveEnd = resolve;
      const tick = (now: number) => {
        let f = this.startFrame + ((now - this.t0) / 1000) * m.fps * rate;
        if (f >= n - 1) {
          if (opts.loop) { this.t0 = now; this.startFrame = 0; f = 0; this.puppet.showAt(0); }
          else { this.draw(n - 1); opts.onFrame?.(n - 1, this.signAt(n - 1)); this.raf = 0; this.resolveEnd = null; resolve(); return; }
        }
        this.draw(f);
        opts.onFrame?.(Math.floor(f), this.signAt(f));
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  /** Bake and play a sentence of sign motions right away. */
  async playSentence(motions: unknown[], opts: PlayOptions & { blendS?: number } = {}): Promise<Loaded> {
    const info = this.loadSentence(motions, opts.blendS);
    await this.play(opts);
    return info;
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resolveEnd?.();
    this.resolveEnd = null;
  }

  /** Show a (fractional) frame without playing. */
  seek(frame: number) { this.stop(); this.draw(frame); }

  /** The sign under a frame, from the sentence segments. */
  signAt(frame: number): string | null {
    const s = this.segments?.find((x) => x.gloss && frame >= x.start && frame < x.end);
    return s?.gloss ?? null;
  }

  dispose() { this.stop(); this.puppet.renderer.dispose(); }

  private draw(frame: number) {
    if (!this.motion) return;
    this.frame = Math.max(0, Math.min(this.motion.frames.length - 1, frame));
    this.puppet.showAt(this.frame);
    this.puppet.render();
  }
}

export type { Motion, Segment, Pass, Solver };
