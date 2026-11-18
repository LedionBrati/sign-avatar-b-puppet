import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { accentShadow, colors, fontMedium, glassShadow } from "../theme";

/** White frosted glass (expo-blur + a white tint), a bright 1 px rim and a soft violet shadow, as the web app's
 *  light panes. The shadow sits on the outer view and the blur is clipped inside, so iOS doesn't cut the shadow off. */
export function Glass({ children, style, intensity = 30, tint = colors.glass, radius = 999, large = false, flat = false, testID }: {
  children?: ReactNode; style?: StyleProp<ViewStyle>; intensity?: number; tint?: string; radius?: number;
  /** Card-sized shadow instead of the pill-sized one. */ large?: boolean;
  /** No shadow (glass lying on glass). */ flat?: boolean; testID?: string;
}) {
  return (
    <View testID={testID} style={[{ borderRadius: radius, zIndex: 0 }, !flat && glassShadow(large), style]}>
      {/* zIndex -1: under the children even when they are not positioned (react-native-web paints an Svg below absolute siblings) */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden", zIndex: -1 }]}>
        <BlurView intensity={intensity} tint="light" style={StyleSheet.absoluteFill} experimentalBlurMethod={Platform.OS === "android" ? "dimezisBlurView" : undefined} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
        {/* the faint diagonal sheen of the web glass (--glass) */}
        <LinearGradient colors={["rgba(255,255,255,0.3)", "rgba(255,255,255,0)", "rgba(255,255,255,0.16)"]} locations={[0, 0.5, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 1, borderColor: colors.rim }]} />
      </View>
      {children}
    </View>
  );
}

/** The accent fill (the violet-blue top-to-bottom gradient) for the one primary button on a screen. */
export function AccentFill({ radius = 999 }: { radius?: number }) {
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden", zIndex: -1 }]}>
      <LinearGradient colors={[...colors.accentGrad]} locations={[0, 0.55, 1]} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 1, borderColor: "rgba(255,255,255,0.28)" }]} />
    </View>
  );
}

/** Pill button ("Stop", "Replay"): white glass with dark ink; `on` = the accent fill with white type ("Listen again"). */
export function Pill({ label, onPress, on, small = true, testID }: { label: string; onPress: () => void; on?: boolean; small?: boolean; testID?: string }) {
  const box = { minHeight: small ? 38 : 52, justifyContent: "center" as const, paddingHorizontal: small ? 17 : 30 };
  const txt = { color: on ? colors.white : colors.label, fontSize: small ? 14.5 : 17, fontWeight: "600" as const, letterSpacing: -0.15, fontFamily: fontMedium };
  return (
    <Pressable onPress={onPress} accessibilityRole="button" testID={testID} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.95 : 1 }] })}>
      {on ? (
        <View style={[box, { borderRadius: 999, zIndex: 0 }, accentShadow]}>
          <AccentFill />
          <Text style={txt}>{label}</Text>
        </View>
      ) : (
        <Glass style={box}><Text style={txt}>{label}</Text></Glass>
      )}
    </Pressable>
  );
}
