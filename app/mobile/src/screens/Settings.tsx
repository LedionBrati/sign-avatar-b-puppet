// Server settings: the URL of app/server on the laptop (LAN IP, port 8787), persisted; Test connection
// calls GET /api/health. Styled as the web app's settings sheet: serif title, quiet pill buttons, one accent Save.
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createSignClient } from "@flux/core";
import { detectServerUrl, normalizeUrl, PLACEHOLDER } from "../lib/settings";
import { accentShadow, colors, font, fontMedium, radii, serif } from "../theme";
import { Field } from "../components/Field";
import { AccentFill } from "../components/Glass";

export function Settings({ visible, url, onSave, onClose }: { visible: boolean; url: string; onSave: (u: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(url);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const detected = detectServerUrl();
  useEffect(() => { if (visible) { setValue(url); setStatus(null); } }, [visible, url]);

  const test = async () => {
    const u = normalizeUrl(value);
    if (!u) { setStatus({ ok: false, msg: "Enter the server address first." }); return; }
    setTesting(true); setStatus(null);
    try {
      const h = await createSignClient(u, { timeoutMs: 5000 }).health();
      setStatus({ ok: true, msg: `Connected · ${h.signs} signs · meaning match ${h.semantic}` });
    } catch (e) {
      setStatus({ ok: false, msg: `No answer from ${u}. Same Wi-Fi? Server running? (${e instanceof Error ? e.message : "error"})` });
    } finally { setTesting(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <Field>
      <SafeAreaView style={s.root}>
        <View style={s.head}>
          <Text style={s.title}>Server</Text>
          <Pressable onPress={onClose} style={s.textbtn} accessibilityRole="button" testID="settings-close" hitSlop={10}><Text style={s.link}>Close</Text></Pressable>
        </View>
        <Text style={s.label}>Signing server URL</Text>
        <TextInput value={value} onChangeText={setValue} placeholder={PLACEHOLDER} placeholderTextColor={colors.label3} autoCapitalize="none" autoCorrect={false}
          keyboardType="url" style={s.input} testID="server-url" />
        <Text style={s.hint}>
          Run <Text style={s.code}>node app/server/index.mjs</Text> on the laptop, then use its LAN IP with port 8787 (phone and laptop on the same Wi-Fi).
          {detected ? <Text> Detected: <Text style={s.code} onPress={() => setValue(detected)}>{detected}</Text> (tap to use).</Text> : null}
        </Text>
        <View style={s.row}>
          <Pressable onPress={test} style={[s.btn, s.ghost]} accessibilityRole="button" testID="server-test">
            {testing ? <ActivityIndicator color={colors.accent} /> : <Text style={[s.btnTxt, { color: colors.label }]}>Test connection</Text>}
          </Pressable>
          <Pressable onPress={() => { onSave(value); onClose(); }} style={[s.btn, accentShadow]} accessibilityRole="button" testID="server-save">
            <AccentFill />
            <Text style={s.btnTxt}>Save</Text>
          </Pressable>
        </View>
        {status ? <Text style={[s.status, { color: status.ok ? "#137a3a" : "#b3261e" }]}>{status.msg}</Text> : null}
      </SafeAreaView>
      </Field>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 18 },
  title: { fontSize: 32, fontWeight: "500", color: colors.label, letterSpacing: -0.6, fontFamily: serif },
  textbtn: { minHeight: 40, paddingHorizontal: 16, borderRadius: 999, justifyContent: "center", backgroundColor: colors.fill2, borderWidth: 1, borderColor: colors.hair },
  link: { color: colors.label, fontSize: 15, fontWeight: "600", fontFamily: fontMedium },
  label: { color: colors.label2, fontSize: 12, fontWeight: "600", letterSpacing: 1.4, textTransform: "uppercase", marginTop: 8, marginBottom: 8, marginHorizontal: 12, fontFamily: fontMedium },
  input: { height: 54, borderRadius: 18, backgroundColor: colors.fill2, paddingHorizontal: 16, fontSize: 16, color: colors.label, borderWidth: 1, borderColor: colors.hair, fontFamily: font },
  hint: { color: colors.label2, fontSize: 13, lineHeight: 19, marginTop: 12, marginHorizontal: 12, fontFamily: font },
  code: { fontFamily: "monospace", color: colors.accent },
  row: { flexDirection: "row", gap: 10, marginTop: 22 },
  btn: { flex: 1, zIndex: 0, height: 50, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  ghost: { backgroundColor: colors.fill2, borderWidth: 1, borderColor: colors.hair },
  btnTxt: { color: colors.white, fontSize: 15, fontWeight: "600", fontFamily: fontMedium },
  status: { marginTop: 16, marginHorizontal: 12, fontSize: 14, lineHeight: 20, fontFamily: font },
});
