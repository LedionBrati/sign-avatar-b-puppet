// The listening wave's glowing lobes, shared by the web app (app/web/src/lib/signWave.ts) and the extension card
// (app/extension/lib/wave.ts): per colour layer, two short-lived lobes (gaussian bumps with a moving sine ripple) that
// fade in and out and are replaced by new random ones. Each client drives the level and draws its own centre line.

export interface Lobe { c: number; w: number; at: number; a: number; f: number; p: number; ps: number; life: number; dur: number }

export interface WaveLobesOptions {
  /** "r,g,b" per layer (tokens.ts waveColors). */
  colors: readonly string[];
  /** Points across the width. */
  points: number;
  /** A lobe's peak alpha: at + random * atRange. */
  at: number; atRange: number;
  /** A lobe's lifetime in seconds: dur + random * durRange. */
  dur: number; durRange: number;
}

export interface WaveLobes {
  /** Advance the lobes by dt seconds and fill them, `amp` px tall around `mid`, over a canvas `W` px wide (d = pixel ratio). */
  draw(ctx: CanvasRenderingContext2D, dt: number, W: number, mid: number, amp: number, d: number): void;
}

export function createWaveLobes(o: WaveLobesOptions): WaveLobes {
  const spawn = (): Lobe => ({ c: Math.random() * 1.3 - 0.65, w: 0.16 + Math.random() * 0.24, at: o.at + Math.random() * o.atRange, a: 0,
    f: 6 + Math.random() * 6, p: Math.random() * 6.28, ps: (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 1.6), life: 0, dur: o.dur + Math.random() * o.durRange });
  const layers = o.colors.map((c) => ({ c, lobes: [spawn(), spawn()] }));
  layers.forEach((L) => L.lobes.forEach((b) => (b.life = Math.random() * b.dur)));
  const N = o.points;
  const ys = new Float32Array(N + 1);
  return {
    draw(ctx, dt, W, mid, amp, d) {
      ctx.globalCompositeOperation = "lighter";
      for (const L of layers) {
        L.lobes.forEach((b, j) => {
          b.life += dt;
          const k = b.life / b.dur;
          if (k >= 1) { L.lobes[j] = spawn(); return; }
          b.a = Math.pow(Math.sin(Math.PI * k), 1.6) * b.at;
          b.p += b.ps * dt;
        });
        for (let i = 0; i <= N; i++) {
          const x = -1 + (2 * i) / N;
          let y = 0;
          for (const b of L.lobes) { const e = Math.exp(-(((x - b.c) / b.w) ** 2)); const s = Math.sin(b.f * (x - b.c) + b.p); y += b.a * e * s * s; }
          ys[i] = Math.min(1, y);
        }
        ctx.beginPath();
        ctx.moveTo(0, mid);
        for (let i = 0; i <= N; i++) ctx.lineTo((i / N) * W, mid - ys[i]! * amp);
        for (let i = N; i >= 0; i--) ctx.lineTo((i / N) * W, mid + ys[i]! * amp);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, mid - amp, 0, mid + amp + 0.01);
        g.addColorStop(0, `rgba(${L.c},0.05)`); g.addColorStop(0.5, `rgba(${L.c},0.9)`); g.addColorStop(1, `rgba(${L.c},0.05)`);
        ctx.fillStyle = g;
        ctx.shadowColor = `rgba(${L.c},0.8)`;
        ctx.shadowBlur = 14 * d;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";
    },
  };
}

/** Size the canvas backing store to its box at the device pixel ratio (capped at 2). Returns the ratio used. */
export function fitCanvas(canvas: HTMLCanvasElement): number {
  const r = canvas.getBoundingClientRect();
  const d = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(2, Math.round(r.width * d));
  canvas.height = Math.max(2, Math.round(r.height * d));
  return d;
}
