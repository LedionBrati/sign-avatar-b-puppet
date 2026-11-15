import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { colors, fontMedium } from "../theme";

/** Frosted glass surface (expo-blur) with a light tint. */
export function Glass({ children, style, intensity = 30, tint = "rgba(255,255,255,0.13)", radius = 999 }: { children?: ReactNode; style?: StyleProp<ViewStyle>; intensity?: number; tint?: string; radius?: number }) {
  return (
    <View style={[{ borderRadius: radius, overflow: "hidden" }, style]}>
      <BlurView intensity={intensity} tint="light" style={StyleSheet.absoluteFill} experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : undefined} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      {children}
    </View>
  );
}

/** Glass pill button ("Stop", "Replay"); `on` = solid white with blue ink ("Listen again"). */
export function Pill({ label, onPress, on, small = true, testID }: { label: string; onPress: () => void; on?: boolean; small?: boolean; testID?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" testID={testID} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.97 : 1 }] })}>
      <Glass tint={on ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.18)"} style={{ minHeight: small ? 36 : 52, justifyContent: "center", paddingHorizontal: small ? 16 : 30 }}>
        <Text style={{ color: on ? colors.inkBlue : colors.white, fontSize: small ? 14 : 17, fontWeight: "500", fontFamily: fontMedium }}>{label}</Text>
      </Glass>
    </Pressable>
  );
}
