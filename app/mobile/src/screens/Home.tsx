// Home: grainy cobalt field, mark + wordmark, headline, the idle listening wave and one white
// "Tap to listen" pill (like Siri / Voice Memos), and the browser extension as a single clean cell.
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { Field } from "../components/Field";
import { Mark } from "../components/Mark";
import { Wordmark } from "../components/Wordmark";
import { SignWave } from "../components/SignWave";
import { Glass } from "../components/Glass";
import { canListen } from "../lib/speech";
import { colors, copy, font, fontMedium, shadow } from "../theme";

function ExtIcon() {
  return (
    <Svg width={30} height={23} viewBox="0 0 40 30">
      <Rect x={1} y={1} width={38} height={28} rx={6} fill="none" stroke="#fff" strokeWidth={1.6} />
      <Path d="M1 8h38" stroke="#fff" strokeWidth={1.6} />
      <Circle cx={6} cy={4.6} r={1.1} fill="#fff" />
      <Circle cx={10} cy={4.6} r={1.1} fill="#fff" />
      <Rect x={6} y={13} width={15} height={2.2} rx={1.1} fill="#fff" opacity={0.55} />
      <Rect x={6} y={18} width={10} height={2.2} rx={1.1} fill="#fff" opacity={0.55} />
      <Circle cx={30} cy={20} r={6} fill="#fff" />
      <Circle cx={30} cy={18.6} r={1.8} fill="#1f3fd6" />
      <Path d="M26.6 24c.7-1.8 2-2.6 3.4-2.6s2.7.8 3.4 2.6" fill="#1f3fd6" />
    </Svg>
  );
}

function Gear() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={1.7} strokeLinecap="round">
      <Path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <Circle cx={16} cy={7} r={2.2} />
      <Circle cx={8} cy={17} r={2.2} />
    </Svg>
  );
}

export function Home({ onListen, onType, onSettings }: { onListen: () => void; onType: () => void; onSettings: () => void }) {
  return (
    <Field>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom", "left", "right"]}>
        <View style={s.bar}>
          <Mark size={28} />
          <View style={{ marginLeft: 10 }}><Wordmark size={15} /></View>
          <Pressable onPress={onSettings} style={s.gear} accessibilityRole="button" accessibilityLabel="Server settings" testID="settings" hitSlop={10}>
            <Gear />
          </Pressable>
        </View>
        <View style={s.headline}>
          <Text style={s.h1} accessibilityRole="header">{copy.headline}</Text>
          <Text style={s.sub}>{copy.sub}</Text>
        </View>
        <View style={s.orbwrap}>
          <Pressable onPress={onListen} style={{ width: "100%" }} accessible={false}>
            <SignWave level={0.3} talking height={140} />
          </Pressable>
          <Pressable onPress={onListen} accessibilityRole="button" testID="listen" style={({ pressed }) => [s.listen, shadow(18, 40, "rgba(5,15,90,0.55)"), { transform: [{ scale: pressed ? 0.96 : 1 }] }]}>
            <Text style={s.listenTxt}>{copy.listen}</Text>
          </Pressable>
          <Pressable onPress={onType} accessibilityRole="button" testID="type" hitSlop={8}>
            <Text style={s.typeLink}>{canListen ? "or type to sign" : "Type to sign · speech needs a dev build"}</Text>
          </Pressable>
        </View>
        <Text style={s.any}>{copy.any}</Text>
        <Glass radius={22} tint="rgba(255,255,255,0.13)" intensity={20} style={s.ext}>
          <View style={s.extIcon}><ExtIcon /></View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.extB}>{copy.extTitle}</Text>
            <Text style={s.extS}>{copy.extSub}</Text>
          </View>
          <Text style={s.extGo}>›</Text>
        </Glass>
      </SafeAreaView>
    </Field>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingTop: 16, paddingBottom: 10 },
  gear: { marginLeft: "auto", width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.14)" },
  headline: { paddingHorizontal: 28, paddingTop: 30 },
  h1: { color: "#fff", fontSize: 38, lineHeight: 40, fontWeight: "600", letterSpacing: -1.3, fontFamily: fontMedium },
  sub: { color: "rgba(255,255,255,0.72)", fontSize: 16, lineHeight: 21.6, letterSpacing: -0.16, marginTop: 12, maxWidth: 270, fontFamily: font },
  orbwrap: { flex: 1, minHeight: 0, alignItems: "center", justifyContent: "center", gap: 22 },
  listen: { minHeight: 48, paddingHorizontal: 28, borderRadius: 999, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  listenTxt: { color: colors.inkBlue, fontSize: 16, fontWeight: "500", letterSpacing: -0.16, fontFamily: fontMedium },
  typeLink: { color: "rgba(255,255,255,0.75)", fontSize: 13.5, textDecorationLine: "underline", fontFamily: font, marginTop: -8 },
  any: { color: "rgba(255,255,255,0.58)", fontSize: 12.5, lineHeight: 17.5, textAlign: "center", maxWidth: 280, alignSelf: "center", fontFamily: font },
  ext: { flexDirection: "row", alignItems: "center", gap: 14, marginHorizontal: 16, marginTop: 22, marginBottom: 14, paddingVertical: 14, paddingHorizontal: 16 },
  extIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.16)", alignItems: "center", justifyContent: "center" },
  extB: { color: "#fff", fontWeight: "600", fontSize: 15, letterSpacing: -0.15, fontFamily: fontMedium },
  extS: { color: "rgba(255,255,255,0.68)", fontSize: 13, lineHeight: 17, fontFamily: font },
  extGo: { color: "rgba(255,255,255,0.55)", fontSize: 26, lineHeight: 28 },
});
