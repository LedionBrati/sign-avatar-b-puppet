import Svg, { Defs, LinearGradient, Rect, Stop, Text } from "react-native-svg";

/** The Flux mark, as in the web app: pastel gradient tile with a serif italic f. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessibilityLabel="Flux icon">
      <Defs>
        <LinearGradient id="fluxg" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#ff9ad5" />
          <Stop offset="0.5" stopColor="#8b7cff" />
          <Stop offset="1" stopColor="#5ee7ff" />
        </LinearGradient>
      </Defs>
      <Rect width={32} height={32} rx={9} fill="url(#fluxg)" />
      <Text x={15.4} y={23.4} textAnchor="middle" fill="#ffffff" fontSize={22} fontStyle="italic" fontWeight="500" fontFamily="Georgia, serif">f</Text>
    </Svg>
  );
}
