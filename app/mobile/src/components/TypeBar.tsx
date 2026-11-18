import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { accentShadow, colors, font } from "../theme";
import { AccentFill, Glass } from "./Glass";

/** "Type to sign": the fallback when on-device speech isn't available, and always a secondary control. */
export function TypeBar({ onSubmit, busy, autoFocus }: { onSubmit: (text: string) => void; busy?: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const send = () => { const t = text.trim(); if (!t) return; onSubmit(t); setText(""); };
  const empty = !text.trim();
  return (
    <Glass radius={999} style={s.bar}>
      <TextInput
        value={text} onChangeText={setText} onSubmitEditing={send} placeholder="Type to sign…" placeholderTextColor={colors.label3}
        style={s.input} returnKeyType="send" autoFocus={autoFocus} accessibilityLabel="Type to sign" testID="type-input" blurOnSubmit={false}
      />
      <Pressable onPress={send} accessibilityRole="button" accessibilityLabel="Sign this" testID="type-send" style={[s.send, empty ? s.sendOff : accentShadow]}>
        {!empty || busy ? <AccentFill /> : null}
        {busy ? <Text style={s.dots}>···</Text> : (
          <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M5 12h13M13 6l6 6-6 6" stroke={empty ? colors.label3 : colors.white} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
        )}
      </Pressable>
    </Glass>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", height: 52, paddingLeft: 20, paddingRight: 6 },
  input: { flex: 1, color: colors.label, fontSize: 16, fontFamily: font, paddingVertical: 0, outlineStyle: "none" } as object,
  send: { width: 40, height: 40, borderRadius: 20, zIndex: 0, alignItems: "center", justifyContent: "center" },
  sendOff: { backgroundColor: colors.fill2, borderWidth: 1, borderColor: colors.hair },
  dots: { color: colors.white, fontSize: 16, fontWeight: "700" },
});
