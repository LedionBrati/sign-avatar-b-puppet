import Svg, { G, Rect } from "react-native-svg";

/** The SIGNLAYER mark: tile + two tilted bars. On blue: white tile, cobalt bars. */
export function Mark({ size = 28, tile = "#ffffff", bars = "#1f3fd6" }: { size?: number; tile?: string; bars?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityLabel="SIGNLAYER icon">
      <Rect width={32} height={32} rx={7.4} fill={tile} />
      <G fill={bars}>
        <Rect x={12.65} y={11.8} width={12.3} height={3} rx={1.5} transform="rotate(-6.5 18.8 13.3)" />
        <Rect x={7} y={16.7} width={14.4} height={3} rx={1.5} transform="rotate(-6.5 14.2 18.2)" />
      </G>
    </Svg>
  );
}
