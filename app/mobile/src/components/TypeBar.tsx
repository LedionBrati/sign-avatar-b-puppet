import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { colors, font } from "../theme";
import { Glass } from "./Glass";

/** "Type to sign": the fallback when on-device speech isn't available, and always a secondary control. */
export function TypeBar({ onSubmit, busy, autoFocus }: { onSubmit: (text: string) => void; busy?: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const send = () => { const t = text.trim(); if (!t) return; onSubmit(t); setText(""); };
  return (
    <Glass radius={999} tint="rgba(255,255,255,0.16)" style={s.bar}>
      <TextInput
        value={text} onChangeText={setText} onSubmitEditing={send} placeholder="Type to sign…" placeholderTextColor="rgba(255,255,255,0.6)"
        style={s.input} returnKeyType="send" autoFocus={autoFocus} accessibilityLabel="Type to sign" testID="type-input" blurOnSubmit={false}
      />
      <Pressable onPress={send} accessibilityRole="button" accessibilityLabel="Sign this" testID="type-send" style={[s.send, !text.trim() && { opacity: 0.5 }]}>
        {busy ? <Text style={s.dots}>···</Text> : (
          <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M5 12h13M13 6l6 6-6 6" stroke={colors.inkBlue} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
        )}
      </Pressable>
    </Glass>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", height: 46, paddingLeft: 18, paddingRight: 5 },
  input: { flex: 1, color: "#fff", fontSize: 16, fontFamily: font, paddingVertical: 0, outlineStyle: "none" } as object,
  send: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  dots: { color: colors.inkBlue, fontSize: 16, fontWeight: "700" },
});
