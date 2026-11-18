import { Text } from "react-native";
import { colors, serif } from "../theme";

/** "flux": lowercase serif italic in the ink, as in the web app. */
export function Wordmark({ size = 15 }: { size?: number }) {
  return (
    <Text accessibilityRole="text" accessibilityLabel="Flux"
      style={{ fontSize: size * 1.25, lineHeight: size * 1.4, color: colors.label, fontFamily: serif, fontStyle: "italic", fontWeight: "500" }}>
      flux
    </Text>
  );
}
