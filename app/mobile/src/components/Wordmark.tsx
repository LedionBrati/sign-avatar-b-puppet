import { Platform, Text } from "react-native";
import { colors } from "../theme";

const serif = Platform.select({ ios: "Georgia", android: "serif", default: "Newsreader, Georgia, serif" });

/** "flux": lowercase serif italic, as in the web app. */
export function Wordmark({ size = 15, light = true }: { size?: number; light?: boolean }) {
  return (
    <Text accessibilityRole="text" accessibilityLabel="Flux"
      style={{ fontSize: size * 1.25, lineHeight: size * 1.4, color: light ? colors.white : colors.ink, fontFamily: serif, fontStyle: "italic", fontWeight: "500" }}>
      flux
    </Text>
  );
}
