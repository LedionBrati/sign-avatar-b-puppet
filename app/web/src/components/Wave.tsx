import { useEffect, useRef } from "react";
import { signWave, type WaveHandle } from "../lib/signWave";

export function Wave({ level, talking, className, id, getLevel }: { level: number; talking: boolean; className?: string; id?: string; getLevel?: () => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const h = useRef<WaveHandle | null>(null);
  useEffect(() => {
    h.current = signWave(ref.current!, { level, talking, getLevel });
    return () => h.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { h.current?.set({ level, talking }); }, [level, talking]);
  return <canvas ref={ref} id={id} className={className} aria-hidden="true" />;
}
