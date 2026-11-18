// Home, in the web app's light look: the pastel field, mark + wordmark, headline, the idle listening wave and one
// white glass "Tap to listen" pill (the serif italic, as the web's orb label), a smaller glass "Sign to speak" pill
// for the other direction, and the browser extension as a single glass cell.
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { Field } from "../components/Field";
import { Mark } from "../components/Mark";
import { Wordmark } from "../components/Wordmark";
import { SignWave } from "../components/SignWave";
import { Glass } from "../components/Glass";
import { canListen } from "../lib/speech";
import { colors, copy, font, fontMedium, serif, shadow } from "../theme";

const A = colors.accent;

function ExtIcon() {
  return (
    <Svg width={30} height={23} viewBox="0 0 40 30">
      <Rect x={1} y={1} width={38} height={28} rx={6} fill="none" stroke={A} strokeWidth={1.6} />
      <Path d="M1 8h38" stroke={A} strokeWidth={1.6} />
      <Circle cx={6} cy={4.6} r={1.1} fill={A} />
      <Circle cx={10} cy={4.6} r={1.1} fill={A} />
      <Rect x={6} y={13} width={15} height={2.2} rx={1.1} fill={A} opacity={0.45} />
      <Rect x={6} y={18} width={10} height={2.2} rx={1.1} fill={A} opacity={0.45} />
      <Circle cx={30} cy={20} r={6} fill={A} />
      <Circle cx={30} cy={18.6} r={1.8} fill="#fff" />
      <Path d="M26.6 24c.7-1.8 2-2.6 3.4-2.6s2.7.8 3.4 2.6" fill="#fff" />
    </Svg>
  );
}

function MicIcon() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={A} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Rect x={9} y={3} width={6} height={11} rx={3} />
      <Path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </Svg>
  );
}

function HandIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={A} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5V4a1.5 1.5 0 0 1 3 0v7.5M14 11.5V5.5a1.5 1.5 0 0 1 3 0V14" />
      <Path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3.6 15.4a1.6 1.6 0 0 1 2.5-2L8 15.5" />
    </Svg>
  );
}

function Gear() {
  return (
    <Svg width={19} height={19} viewBox="0 0 24 24" fill="none" stroke={colors.label} strokeWidth={1.7} strokeLinecap="round">
      <Path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <Circle cx={16} cy={7} r={2.2} />
      <Circle cx={8} cy={17} r={2.2} />
    </Svg>
  );
}

export function Home({ onListen, onType, onSign, onSettings }: { onListen: () => void; onType: () => void; onSign: () => void; onSettings: () => void }) {
  return (
    <Field>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom", "left", "right"]}>
        <View style={s.bar}>
          <Mark size={28} />
          <View style={{ marginLeft: 10 }}><Wordmark size={15} /></View>
          <Pressable onPress={onSettings} style={({ pressed }) => [s.gear, { transform: [{ scale: pressed ? 0.9 : 1 }] }]} accessibilityRole="button" accessibilityLabel="Server settings" testID="settings" hitSlop={10}>
            <Glass style={s.gearIn}><Gear /></Glass>
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
          <Pressable onPress={onListen} accessibilityRole="button" testID="listen" style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.96 : 1 }] })}>
            <Glass tint="rgba(255,255,255,0.8)" style={[s.listen, shadow(16, 40, "rgba(91,92,240,0.4)")]}>
              <MicIcon />
              <Text style={s.listenTxt}>{copy.listen}</Text>
            </Glass>
          </Pressable>
          <Pressable onPress={onSign} accessibilityRole="button" accessibilityLabel="Sign to speak" testID="sign" style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.96 : 1 }], marginTop: -6 })}>
            <Glass style={s.signBtn}>
              <HandIcon />
              <Text style={s.signTxt}>Sign to speak</Text>
            </Glass>
          </Pressable>
          <Pressable onPress={onType} accessibilityRole="button" testID="type" hitSlop={8}>
            <Text style={s.typeLink}>{canListen ? "or type to sign" : "Type to sign · speech needs a dev build"}</Text>
          </Pressable>
        </View>
        <Text style={s.any}>{copy.any}</Text>
        <Glass radius={26} large style={s.ext}>
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
  bar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
  gear: { marginLeft: "auto" },
  gearIn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headline: { paddingHorizontal: 28, paddingTop: 30 },
  h1: { color: colors.label, fontSize: 38, lineHeight: 41, fontWeight: "700", letterSpacing: -1.4, fontFamily: fontMedium },
  sub: { color: colors.label2, fontSize: 16, lineHeight: 21.6, letterSpacing: -0.16, marginTop: 12, maxWidth: 270, fontFamily: font },
  orbwrap: { flex: 1, minHeight: 0, alignItems: "center", justifyContent: "center", gap: 22 },
  listen: { minHeight: 58, paddingHorizontal: 30, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  listenTxt: { color: colors.label, fontSize: 23, fontStyle: "italic", fontWeight: "500", letterSpacing: -0.2, fontFamily: serif },
  signBtn: { minHeight: 46, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  signTxt: { color: colors.label, fontSize: 18, fontStyle: "italic", fontWeight: "500", letterSpacing: -0.15, fontFamily: serif },
  typeLink: { color: colors.label2, fontSize: 13.5, textDecorationLine: "underline", textDecorationColor: colors.label3, fontFamily: font, marginTop: -8 },
  any: { color: colors.label2, fontSize: 12.5, lineHeight: 17.5, textAlign: "center", maxWidth: 280, alignSelf: "center", fontFamily: font },
  ext: { flexDirection: "row", alignItems: "center", gap: 14, marginHorizontal: 16, marginTop: 22, marginBottom: 14, paddingVertical: 14, paddingHorizontal: 16 },
  extIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" },
  extB: { color: colors.label, fontWeight: "600", fontSize: 15, letterSpacing: -0.15, fontFamily: fontMedium },
  extS: { color: colors.label2, fontSize: 13, lineHeight: 17, fontFamily: font },
  extGo: { color: colors.label3, fontSize: 26, lineHeight: 28 },
});
