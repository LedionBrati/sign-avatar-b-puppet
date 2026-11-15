import { StyleSheet, Text, View } from "react-native";
import { colors, fontMedium } from "../theme";

/** "sıgnlayer": lowercase, medium weight, the dotless ı carries a cobalt-ish dot (light variant on blue). */
export function Wordmark({ size = 15, light = true }: { size?: number; light?: boolean }) {
  const ink = light ? colors.white : colors.ink;
  const dot = light ? colors.wordmarkDotOnBlue : colors.cobalt;
  const t = { fontSize: size, lineHeight: size * 1.15, color: ink, fontFamily: fontMedium, fontWeight: "500" as const, letterSpacing: -0.025 * size };
  const d = size * 0.21;
  return (
    <View style={s.row} accessible accessibilityRole="text" accessibilityLabel="signlayer">
      <Text style={t}>s</Text>
      <View>
        <Text style={t}>ı</Text>
        <View style={{ position: "absolute", top: size * 0.17, left: "50%", marginLeft: -d / 2 + size * 0.01, width: d, height: d, borderRadius: d, backgroundColor: dot }} />
      </View>
      <Text style={t}>gnlayer</Text>
    </View>
  );
}

const s = StyleSheet.create({ row: { flexDirection: "row", alignItems: "flex-end" } });
