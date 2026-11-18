// Flux listening wave (ported from the prototype's SignWave): a thin white line with glowing blue lobes that swell with speech.
import { createWaveLobes, fitCanvas, waveColors } from "@flux/core";

export interface WaveOpts { level?: number; talking?: boolean; colors?: readonly string[]; /** live 0..1 level (mic), read every frame; a negative value means none right now */ getLevel?: () => number }
export interface WaveHandle { set(o: { level?: number; talking?: boolean }): void; destroy(): void }

export function signWave(canvas: HTMLCanvasElement, opts: WaveOpts = {}): WaveHandle {
  const ctx = canvas.getContext("2d")!;
  const colors = opts.colors ?? waveColors;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let level = opts.level ?? 0.7, target = level, talking = opts.talking ?? true;
  let base = opts.level ?? 0.7, last = performance.now(), raf = 0, visible = true, d = 1, nextBeat = 0, dead = false;
  const lobes = createWaveLobes({ colors, points: 140, at: 0.4, atRange: 0.6, dur: 1.6, durRange: 2.2 });

  function size() { d = fitCanvas(canvas); }
  function frame(now: number) {
    if (dead || !canvas.isConnected) { raf = 0; return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const live = talking && opts.getLevel ? opts.getLevel() : -1; // < 0: no live level, make up a speech rhythm
    if (live >= 0) target = base * (0.14 + 0.9 * live);
    else if (talking && now > nextBeat) { target = base * (0.45 + Math.random() * 0.55); nextBeat = now + 180 + Math.random() * 260; }
    if (!talking) target = base * 0.04;
    level += (target - level) * Math.min(1, dt * 3.2);
    const W = canvas.width, H = canvas.height, mid = H / 2, amp = (H / 2 - 2 * d) * level;
    ctx.clearRect(0, 0, W, H);
    lobes.draw(ctx, dt, W, mid, amp, d);
    const lg = ctx.createLinearGradient(0, 0, W, 0);
    lg.addColorStop(0, "rgba(255,255,255,0)"); lg.addColorStop(0.18, "rgba(255,255,255,.75)"); lg.addColorStop(0.5, "rgba(255,255,255,1)"); lg.addColorStop(0.82, "rgba(255,255,255,.75)"); lg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = lg; ctx.fillRect(0, mid - 0.6 * d, W, 1.2 * d);
    raf = visible && !reduce ? requestAnimationFrame(frame) : 0;
  }
  function start() { if (!raf && !dead) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  size();
  const ro = new ResizeObserver(size); ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; if (visible) start(); }); io.observe(canvas);
  if (reduce) { level = base * 0.6; requestAnimationFrame(frame); } else start();
  return {
    set(o) { if (o.level != null) base = o.level; if (o.talking != null) talking = o.talking; if (reduce) requestAnimationFrame(frame); },
    destroy() { dead = true; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); },
  };
}
