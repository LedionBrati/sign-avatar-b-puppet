import { useEffect, useRef } from "react";
import { signWave, type WaveHandle } from "../lib/signWave";

/** The voice wave. `getLevel` (a live 0..1 level) may change between renders; the canvas loop always reads the latest. */
export function Wave({ level, talking, className, id, getLevel }: { level: number; talking: boolean; className?: string; id?: string; getLevel?: () => number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const h = useRef<WaveHandle | null>(null);
  const gl = useRef(getLevel);
  gl.current = getLevel;
  useEffect(() => {
    h.current = signWave(ref.current!, { level, talking, getLevel: () => (gl.current ? gl.current() : -1) });
    return () => h.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { h.current?.set({ level, talking }); }, [level, talking]);
  return <canvas ref={ref} id={id} className={className} aria-hidden="true" />;
}
