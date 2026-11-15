// The listening wave, the web app's (app/web/src/lib/signWave.ts): a thin white line with glowing cobalt-to-ice lobes
// that swell with the real audio level, on a soft violet glow so it reads on white glass. Silent: a calm line.
// Drawing stops by itself once the line has settled (no idle CPU), and while the card is hidden.
import { waveColors as COLORS } from "@signlayer/core";

export function createWave(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let level = 0, target = 0, voiced = false, active = false, glow = 0;
  let last = performance.now(), raf = 0, d = 1, still = 0;
  const spawn = () => ({ c: Math.random() * 1.3 - 0.65, w: 0.16 + Math.random() * 0.24, at: 0.45 + Math.random() * 0.55, a: 0,
    f: 6 + Math.random() * 6, p: Math.random() * 6.28, ps: (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 1.6), life: 0, dur: 1.4 + Math.random() * 2 });
  const layers = COLORS.map((c) => ({ c, lobes: [spawn(), spawn()] }));
  layers.forEach((L) => L.lobes.forEach((b) => (b.life = Math.random() * b.dur)));
  const N = 96;
  const ys = new Float32Array(N + 1);

  function size() {
    const r = canvas.getBoundingClientRect();
    d = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(2, Math.round(r.width * d));
    canvas.height = Math.max(2, Math.round(r.height * d));
    kick();
  }

  function frame(now: number) {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    level += (target - level) * Math.min(1, dt * (target > level ? 9 : 3.5));
    glow += ((voiced ? 1 : active ? 0.35 : 0.18) - glow) * Math.min(1, dt * 4);
    const W = canvas.width, H = canvas.height, mid = H / 2, amp = (H / 2 - 2 * d) * level;
    ctx.clearRect(0, 0, W, H);
    if (amp > 0.4) {
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
          const xx = -1 + (2 * i) / N;
          let yy = 0;
          for (const b of L.lobes) { const e = Math.exp(-(((xx - b.c) / b.w) ** 2)); const s = Math.sin(b.f * (xx - b.c) + b.p); yy += b.a * e * s * s; }
          ys[i] = Math.min(1, yy);
        }
        ctx.beginPath();
        ctx.moveTo(0, mid);
        for (let i = 0; i <= N; i++) ctx.lineTo((i / N) * W, mid - ys[i]! * amp);
        for (let i = N; i >= 0; i--) ctx.lineTo((i / N) * W, mid + ys[i]! * amp);
        ctx.closePath();
        const gr = ctx.createLinearGradient(0, mid - amp, 0, mid + amp);
        gr.addColorStop(0, `rgba(${L.c},0.05)`); gr.addColorStop(0.5, `rgba(${L.c},0.9)`); gr.addColorStop(1, `rgba(${L.c},0.05)`);
        ctx.fillStyle = gr;
        ctx.shadowColor = `rgba(${L.c},0.8)`;
        ctx.shadowBlur = 14 * d;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";
    }
    // The centre line: white with a violet glow, brighter while speech is detected.
    const a = 0.55 + glow * 0.45;
    const lg = ctx.createLinearGradient(0, 0, W, 0);
    lg.addColorStop(0, "rgba(255,255,255,0)"); lg.addColorStop(0.18, `rgba(255,255,255,${a * 0.75})`); lg.addColorStop(0.5, `rgba(255,255,255,${a})`);
    lg.addColorStop(0.82, `rgba(255,255,255,${a * 0.75})`); lg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = lg;
    ctx.shadowColor = `rgba(123,108,255,${0.5 + glow * 0.4})`;
    ctx.shadowBlur = 6 * d;
    ctx.fillRect(0, mid - 0.7 * d, W, 1.4 * d);
    ctx.shadowBlur = 0;
    // Settled (silent, line drawn): stop until the next level.
    const settled = Math.abs(target - level) < 0.002 && target < 0.02 && Math.abs(glow - (voiced ? 1 : active ? 0.35 : 0.18)) < 0.01;
    still = settled ? still + 1 : 0;
    if (!reduce && still < 3 && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }

  size();
  new ResizeObserver(size).observe(canvas);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });

  return {
    /** level 0..1 (from the analyser), voiced = speech detected now, on = listening at all. */
    set(l: number, v: boolean, on: boolean) {
      voiced = v;
      active = on;
      target = on ? (v ? Math.min(1, 0.32 + l * 1.5) : 0.05 + Math.min(0.1, l * 0.8)) : 0;
      kick();
    },
  };
}
