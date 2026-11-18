// The listening wave, the web app's (app/web/src/lib/signWave.ts, same lobes from app/core/src/wave.ts): a thin white
// line with glowing cobalt-to-ice lobes that swell with the real audio level, on a soft violet glow so it reads on white
// glass. Silent: a calm line.
// Drawing stops by itself once the line has settled (no idle CPU), and while the card is hidden.
import { createWaveLobes, fitCanvas, waveColors } from "@flux/core";

export function createWave(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let level = 0, target = 0, voiced = false, active = false, glow = 0;
  let last = performance.now(), raf = 0, d = 1, still = 0;
  const lobes = createWaveLobes({ colors: waveColors, points: 96, at: 0.45, atRange: 0.55, dur: 1.4, durRange: 2 });

  function size() {
    d = fitCanvas(canvas);
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
    if (amp > 0.4) lobes.draw(ctx, dt, W, mid, amp, d);
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
