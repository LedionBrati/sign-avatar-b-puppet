// Server settings: the URL of app/server on the laptop (LAN IP, port 8787), persisted; Test connection
// calls GET /api/health.
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createSignClient } from "@signlayer/core";
import { detectServerUrl, normalizeUrl, PLACEHOLDER } from "../lib/settings";
import { colors, font, fontMedium } from "../theme";

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
      <SafeAreaView style={s.root}>
        <View style={s.head}>
          <Text style={s.title}>Server</Text>
          <Pressable onPress={onClose} accessibilityRole="button" testID="settings-close" hitSlop={10}><Text style={s.link}>Close</Text></Pressable>
        </View>
        <Text style={s.label}>Signing server URL</Text>
        <TextInput value={value} onChangeText={setValue} placeholder={PLACEHOLDER} placeholderTextColor="#9aa1c4" autoCapitalize="none" autoCorrect={false}
          keyboardType="url" style={s.input} testID="server-url" />
        <Text style={s.hint}>
          Run <Text style={s.code}>node app/server/index.mjs</Text> on the laptop, then use its LAN IP with port 8787 (phone and laptop on the same Wi-Fi).
          {detected ? <Text> Detected: <Text style={s.code} onPress={() => setValue(detected)}>{detected}</Text> (tap to use).</Text> : null}
        </Text>
        <View style={s.row}>
          <Pressable onPress={test} style={[s.btn, s.ghost]} accessibilityRole="button" testID="server-test">
            {testing ? <ActivityIndicator color={colors.cobalt} /> : <Text style={[s.btnTxt, { color: colors.cobalt }]}>Test connection</Text>}
          </Pressable>
          <Pressable onPress={() => { onSave(value); onClose(); }} style={s.btn} accessibilityRole="button" testID="server-save">
            <Text style={s.btnTxt}>Save</Text>
          </Pressable>
        </View>
        {status ? <Text style={[s.status, { color: status.ok ? "#137a3a" : "#b3261e" }]}>{status.msg}</Text> : null}
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper2, paddingHorizontal: 22 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 18 },
  title: { fontSize: 28, fontWeight: "600", color: colors.ink, letterSpacing: -0.8, fontFamily: fontMedium },
  link: { color: colors.cobalt, fontSize: 16, fontWeight: "500", fontFamily: fontMedium },
  label: { color: colors.inkBlue, fontSize: 13, marginTop: 8, marginBottom: 8, fontFamily: font },
  input: { height: 50, borderRadius: 14, backgroundColor: "#fff", paddingHorizontal: 14, fontSize: 16, color: colors.ink, borderWidth: 1, borderColor: "#dfe3f3", fontFamily: font },
  hint: { color: "#5b6390", fontSize: 13, lineHeight: 19, marginTop: 10, fontFamily: font },
  code: { fontFamily: "monospace", color: colors.inkBlue },
  row: { flexDirection: "row", gap: 10, marginTop: 20 },
  btn: { flex: 1, height: 48, borderRadius: 999, backgroundColor: colors.cobalt, alignItems: "center", justifyContent: "center" },
  ghost: { backgroundColor: "#fff", borderWidth: 1, borderColor: "rgba(31,63,214,0.35)" },
  btnTxt: { color: "#fff", fontSize: 15, fontWeight: "500", fontFamily: fontMedium },
  status: { marginTop: 16, fontSize: 14, lineHeight: 20, fontFamily: font },
});
