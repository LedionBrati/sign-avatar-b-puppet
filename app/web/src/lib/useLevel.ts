// One rAF loop drives every [data-level] element under `root` through a --level custom property (0..1), set on
// those elements only so a frame never restyles the whole screen. Sources:
//   mic   real microphone level (Web Audio), synthetic if the meter is unavailable
//   voice a speech-like synthetic level (typed text being "read")
//   calm  a slow, low breath (signing)
//   rest  settles and stops (done / idle)
import { useEffect, useRef, type RefObject } from "react";
import { openMeter, type Meter } from "./meter";
import { reducedMotion } from "./motion";

export type LevelSource = "mic" | "voice" | "calm" | "rest";

export function useLevel(root: RefObject<HTMLElement | null>, source: LevelSource) {
  const level = useRef(0);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let meter: Meter | null = null, raf = 0, dead = false, cur = level.current, frame = 0;
    let targets: HTMLElement[] = [];
    if (source === "mic") void openMeter().then((m) => { if (dead) m?.stop(); else meter = m; });
    const write = (v: number) => { const s = v.toFixed(3); for (const t of targets) t.style.setProperty("--level", s); };
    const goal = (t: number) => {
      if (source === "mic" && meter) return meter.level();
      if (source === "mic" || source === "voice") return 0.32 + 0.22 * Math.sin(t / 210) * Math.sin(t / 1270) + 0.12 * Math.sin(t / 83 + 1.3);
      if (source === "calm") return 0.2 + 0.06 * Math.sin(t / 1400);
      return 0.06;
    };
    if (reducedMotion()) {
      targets = [...el.querySelectorAll<HTMLElement>("[data-level]")];
      write(source === "rest" ? 0.06 : 0.25);
      return;
    }
    const tick = (t: number) => {
      if (dead) return;
      if (frame++ % 30 === 0) targets = [...el.querySelectorAll<HTMLElement>("[data-level]")];
      const g = goal(t);
      cur += (g - cur) * 0.14;
      level.current = cur;
      write(cur);
      if (source === "rest" && Math.abs(g - cur) < 0.002) return; // settled: stop the loop (battery)
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { dead = true; cancelAnimationFrame(raf); meter?.stop(); };
  }, [root, source]);
  return level;
}
