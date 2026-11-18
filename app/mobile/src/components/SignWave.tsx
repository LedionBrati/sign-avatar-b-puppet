// Flux listening wave (the web app's canvas wave, lib/signWave.ts, ported to react-native-svg): the same blue lobes
// that swell while someone is talking, around a thin white line on a soft violet glow so it reads on the light
// background (as the extension's wave does). ~30 fps, cheap paths.
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, View, type LayoutChangeEvent } from "react-native";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { colors, waveColors } from "../theme";

type Lobe = { c: number; w: number; at: number; a: number; f: number; p: number; ps: number; life: number; dur: number };
const spawn = (): Lobe => ({
  c: Math.random() * 1.3 - 0.65, w: 0.16 + Math.random() * 0.24, at: 0.4 + Math.random() * 0.6, a: 0,
  f: 6 + Math.random() * 6, p: Math.random() * 6.28, ps: (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random() * 1.6), life: 0, dur: 1.6 + Math.random() * 2.2,
});
const N = 56;

export function SignWave({ level = 0.7, talking = true, height = 140 }: { level?: number; talking?: boolean; height?: number }) {
  const [w, setW] = useState(0);
  const [, setTick] = useState(0);
  const st = useRef({
    layers: waveColors.map((c) => ({ c, lobes: [spawn(), spawn()].map((b) => ({ ...b, life: Math.random() * b.dur })) })),
    level, target: level, nextBeat: 0, last: 0,
  });
  const props = useRef({ level, talking });
  props.current = { level, talking };
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduce).catch(() => {});
  }, []);

  useEffect(() => {
    let raf = 0, lastDraw = 0;
    const frame = (now: number) => {
      const S = st.current, P = props.current;
      const dt = Math.min(0.05, S.last ? (now - S.last) / 1000 : 0.016);
      S.last = now;
      if (P.talking && now > S.nextBeat) { S.target = P.level * (0.45 + Math.random() * 0.55); S.nextBeat = now + 180 + Math.random() * 260; }
      if (!P.talking) S.target = P.level * 0.04;
      S.level += (S.target - S.level) * Math.min(1, dt * 3.2);
      for (const L of S.layers) {
        L.lobes.forEach((b, j) => {
          b.life += dt;
          const k = b.life / b.dur;
          if (k >= 1) { L.lobes[j] = spawn(); return; }
          b.a = Math.pow(Math.sin(Math.PI * k), 1.6) * b.at; b.p += b.ps * dt;
        });
      }
      if (now - lastDraw > 33) { lastDraw = now; setTick((t) => (t + 1) % 1e6); }
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  const onLayout = (e: LayoutChangeEvent) => setW(Math.round(e.nativeEvent.layout.width));
  const H = height, mid = H / 2, S = st.current, amp = (H / 2 - 2) * S.level;

  const paths = w
    ? S.layers.map((L) => {
        const ys: number[] = [];
        for (let i = 0; i <= N; i++) {
          const x = -1 + (2 * i) / N;
          let y = 0;
          for (const b of L.lobes) { const e = Math.exp(-(((x - b.c) / b.w) ** 2)); const s = Math.sin(b.f * (x - b.c) + b.p); y += b.a * e * s * s; }
          ys.push(Math.min(1, y));
        }
        let d = `M0 ${mid}`;
        for (let i = 0; i <= N; i++) d += `L${((i / N) * w).toFixed(1)} ${(mid - ys[i]! * amp).toFixed(1)}`;
        for (let i = N; i >= 0; i--) d += `L${((i / N) * w).toFixed(1)} ${(mid + ys[i]! * amp).toFixed(1)}`;
        return { c: L.c, d: d + "Z" };
      })
    : [];

  return (
    <View style={{ width: "100%", height: H }} onLayout={onLayout} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {w > 0 && (
        <Svg width={w} height={H}>
          <Defs>
            {waveColors.map((c, i) => (
              <LinearGradient key={c} id={`wl${i}`} x1="0" y1={mid - amp} x2="0" y2={mid + amp} gradientUnits="userSpaceOnUse">
                <Stop offset="0" stopColor={`rgb(${c})`} stopOpacity={0.05} />
                <Stop offset="0.5" stopColor={`rgb(${c})`} stopOpacity={0.85} />
                <Stop offset="1" stopColor={`rgb(${c})`} stopOpacity={0.05} />
              </LinearGradient>
            ))}
            <LinearGradient id="wglow" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={colors.wordmarkDot} stopOpacity={0} />
              <Stop offset="0.5" stopColor={colors.wordmarkDot} stopOpacity={0.3} />
              <Stop offset="1" stopColor={colors.wordmarkDot} stopOpacity={0} />
            </LinearGradient>
            <LinearGradient id="wline" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor="#fff" stopOpacity={0} />
              <Stop offset="0.18" stopColor="#fff" stopOpacity={0.75} />
              <Stop offset="0.5" stopColor="#fff" stopOpacity={1} />
              <Stop offset="0.82" stopColor="#fff" stopOpacity={0.75} />
              <Stop offset="1" stopColor="#fff" stopOpacity={0} />
            </LinearGradient>
          </Defs>
          {paths.map((p, i) => (
            <Path key={i} d={p.d} fill={`url(#wl${i})`} />
          ))}
          <Rect x={0} y={mid - 3} width={w} height={6} rx={3} fill="url(#wglow)" />
          <Rect x={0} y={mid - 1.5} width={w} height={3} rx={1.5} fill="url(#wglow)" />
          <Rect x={0} y={mid - 0.8} width={w} height={1.6} fill="url(#wline)" />
        </Svg>
      )}
    </View>
  );
}
