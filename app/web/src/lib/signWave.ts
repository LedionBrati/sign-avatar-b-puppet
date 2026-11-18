// Flux listening wave (ported from the prototype's SignWave): a thin white line with glowing blue lobes that swell with speech.
import { waveColors } from "@flux/core";

export interface WaveOpts { level?: number; talking?: boolean; colors?: readonly string[]; /** live 0..1 level (mic), read every frame; a negative value means none right now */ getLevel?: () => number }
export interface WaveHandle { set(o: { level?: number; talking?: boolean }): void; destroy(): void }

interface Lobe { c: number; w: number; at: number; a: number; f: number; p: number; ps: number; life: number; dur: number }

export function signWave(canvas: HTMLCanvasElement, opts: WaveOpts = {}): WaveHandle {
  const ctx = canvas.getContext("2d")!;
  const colors = opts.colors ?? waveColors;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let level = opts.level ?? 0.7, target = level, talking = opts.talking ?? true;
  let base = opts.level ?? 0.7, last = performance.now(), raf = 0, visible = true, d = 1, nextBeat = 0, dead = false;
  const spawn = (): Lobe => ({ c: Math.random() * 1.3 - 0.65, w: 0.16 + Math.random() * 0.24, at: 0.4 + Math.random() * 0.6, a: 0,
    f: 6 + Math.random() * 6, p: Math.random() * 6.28, ps: (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 1.6), life: 0, dur: 1.6 + Math.random() * 2.2 });
  const layers = colors.map((c) => ({ c, lobes: [spawn(), spawn()] }));
  layers.forEach((L) => L.lobes.forEach((b) => (b.life = Math.random() * b.dur)));
  const N = 140;
  const ys = new Float32Array(N + 1);

  function size() {
    const r = canvas.getBoundingClientRect();
    d = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(2, Math.round(r.width * d));
    canvas.height = Math.max(2, Math.round(r.height * d));
  }
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
    ctx.globalCompositeOperation = "lighter";
    for (const L of layers) {
      L.lobes.forEach((b, j) => {
        b.life += dt; const k = b.life / b.dur;
        if (k >= 1) { L.lobes[j] = spawn(); return; }
        b.a = Math.pow(Math.sin(Math.PI * k), 1.6) * b.at; b.p += b.ps * dt;
      });
      for (let i = 0; i <= N; i++) {
        const x = -1 + (2 * i) / N; let y = 0;
        for (const b of L.lobes) { const e = Math.exp(-(((x - b.c) / b.w) ** 2)); const s = Math.sin(b.f * (x - b.c) + b.p); y += b.a * e * s * s; }
        ys[i] = Math.min(1, y);
      }
      ctx.beginPath(); ctx.moveTo(0, mid);
      for (let i = 0; i <= N; i++) ctx.lineTo((i / N) * W, mid - ys[i]! * amp);
      for (let i = N; i >= 0; i--) ctx.lineTo((i / N) * W, mid + ys[i]! * amp);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, mid - amp, 0, mid + amp + 0.01);
      g.addColorStop(0, `rgba(${L.c},0.05)`); g.addColorStop(0.5, `rgba(${L.c},0.9)`); g.addColorStop(1, `rgba(${L.c},0.05)`);
      ctx.fillStyle = g; ctx.shadowColor = `rgba(${L.c},0.8)`; ctx.shadowBlur = 14 * d; ctx.fill();
    }
    ctx.shadowBlur = 0; ctx.globalCompositeOperation = "source-over";
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
