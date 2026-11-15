// Sign -> speak: the web app's camera screen (MediaPipe runs inside the page) in a framed card, the
// composed sentence in a native caption sheet underneath, and a native Speak button (expo-speech).
// Flow: OS camera permission -> preflight <server>/app/ -> WebView. Each failure gets its own screen.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Camera } from "expo-camera";
import { Field } from "../components/Field";
import { Mark } from "../components/Mark";
import { Pill } from "../components/Glass";
import { SignFrame } from "../components/SignFrame";
import { preflight, signPageUrl, type BridgeMsg, type FrameError } from "../lib/bridge";
import { speakText, stopSpeaking } from "../lib/voice";
import { keepAwake, tap } from "../lib/feedback";
import { colors, font, fontMedium, shadow } from "../theme";

interface Props {
  serverUrl: string;
  onExit: () => void;
  onSettings: () => void;
}

type Phase = "permission" | "denied" | "checking" | "ready" | "error";

export function Sign({ serverUrl, onExit, onSettings }: Props) {
  const url = useMemo(() => signPageUrl(serverUrl), [serverUrl]);
  const [phase, setPhase] = useState<Phase>(Platform.OS === "web" ? "checking" : "permission");
  const [err, setErr] = useState<FrameError | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sentence, setSentence] = useState("");
  const [spoken, setSpoken] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [insecure, setInsecure] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    keepAwake(true);
    return () => { keepAwake(false); stopSpeaking(); };
  }, []);

  // 1. Camera permission (native only; the browser asks for the iframe itself).
  useEffect(() => {
    if (phase !== "permission") return;
    let live = true;
    Camera.requestCameraPermissionsAsync()
      .then((p) => { if (live) setPhase(p.granted ? "checking" : "denied"); })
      .catch(() => { if (live) setPhase("checking"); });
    return () => { live = false; };
  }, [phase]);

  // 2. Is the server up and serving the web app?
  useEffect(() => {
    if (phase !== "checking") return;
    let live = true;
    setErr(null); setLoaded(false);
    preflight(url).then((e) => {
      if (!live) return;
      if (e) { setErr(e); setPhase("error"); } else setPhase("ready");
    });
    return () => { live = false; };
  }, [phase, url, attempt]);

  const speak = useCallback((text: string) => {
    const ok = speakText(text, { start: () => setSpeaking(true), done: () => setSpeaking(false) });
    if (ok) setSpoken(text.trim());
  }, []);

  const onMessage = useCallback((m: BridgeMsg) => {
    if (m.type === "sentence") setSentence(m.text);
    else if (m.type === "speak") { if (m.text) setSentence(m.text); speak(m.text); }
    else if (m.type === "env") setInsecure(!m.secure || !m.media);
  }, [speak]);

  const onFrameError = useCallback((e: FrameError) => { setErr(e); setPhase("error"); }, []);
  const retry = () => { tap("light"); setAttempt((a) => a + 1); setPhase(Platform.OS === "web" ? "checking" : "permission"); };
  const stop = () => { tap("stop"); onExit(); };

  const island = speaking ? "Speaking" : phase === "ready" ? "Signing" : phase === "error" || phase === "denied" ? "Not connected" : "Starting…";

  return (
    <Field>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom", "left", "right"]}>
        <View style={s.bar}>
          <View style={{ flex: 1 }}><Mark size={28} /></View>
          <View style={s.island} testID="island">
            <View style={[s.islandDot, speaking && { backgroundColor: "#9fffc9" }]} />
            <Text style={s.islandTxt}>{island}</Text>
          </View>
          <View style={{ flex: 1, alignItems: "flex-end" }}>
            <Pill label="Stop" onPress={stop} testID="stop" />
          </View>
        </View>

        {phase === "error" || phase === "denied" ? (
          <Problem phase={phase} err={err} url={url} onSettings={onSettings} onRetry={retry} />
        ) : (
          <>
            <View style={[s.card, shadow(18, 40, "rgba(5,15,90,0.5)")]}>
              {phase === "ready" ? <SignFrame key={`${url}#${attempt}`} url={url} onMessage={onMessage} onError={onFrameError} onReady={() => setLoaded(true)} /> : null}
              {!loaded && (
                <View style={s.loading} pointerEvents="none">
                  <ActivityIndicator color="#fff" />
                  <Text style={s.loadingTxt}>{phase === "permission" ? "Asking for the camera…" : "Starting the signing camera…"}</Text>
                </View>
              )}
            </View>

            <View style={s.foot}>
              {insecure ? (
                <Text style={s.warn} testID="insecure">The camera only works on https:// or localhost pages. See the app README (adb reverse or an https tunnel).</Text>
              ) : null}
              <View style={[s.sheet, shadow(18, 40, "rgba(5,15,90,0.45)")]} accessibilityLiveRegion="polite">
                <Text style={s.sheetLbl}>{spoken && spoken === sentence.trim() ? "Spoken" : "Your sentence"}</Text>
                <Text style={[s.sentence, !sentence && s.placeholder]} numberOfLines={3} testID="sign-sentence">
                  {sentence || "Sign in front of the camera. Words appear here."}
                </Text>
              </View>
              <View style={s.acts}>
                <Pressable
                  onPress={() => speak(sentence)}
                  disabled={!sentence.trim()}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !sentence.trim() }}
                  testID="speak"
                  style={({ pressed }) => [s.speak, !sentence.trim() && { opacity: 0.45 }, { transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
                  <Text style={s.speakTxt}>{speaking ? "Speaking…" : "Speak"}</Text>
                </Pressable>
              </View>
              <Text style={s.credit} testID="spoken">{spoken ? `Last spoken: “${spoken}”` : "Spoken aloud on this phone · recognition runs on your server"}</Text>
            </View>
          </>
        )}
      </SafeAreaView>
    </Field>
  );
}

function Problem({ phase, err, url, onSettings, onRetry }: { phase: Phase; err: FrameError | null; url: string; onSettings: () => void; onRetry: () => void }) {
  const denied = phase === "denied";
  const title = denied ? "Camera access is off" : err?.kind === "not-served" ? "The signing page isn't on this server" : "Can't reach the server";
  const body = denied
    ? "SIGNLAYER needs the camera to see your signing. Turn it on in the phone's settings, then try again."
    : err?.kind === "not-served"
      ? "The server answered but doesn't serve the web app at /app/. Build app/web and restart app/server, or check the server URL."
      : "Is app/server running on the laptop, and is the phone on the same Wi-Fi?";
  return (
    <View style={s.problem} testID="sign-error">
      <View style={[s.pcard, shadow(18, 40, "rgba(5,15,90,0.45)")]}>
        <Text style={s.ptitle}>{title}</Text>
        <Text style={s.pbody}>{body}</Text>
        {!denied && (
          <View style={s.urlBox}>
            <Text style={s.urlTxt} selectable numberOfLines={3}>{url}</Text>
            {err?.detail ? <Text style={s.urlDetail} numberOfLines={2}>{err.detail}</Text> : null}
          </View>
        )}
      </View>
      <View style={s.acts}>
        {denied ? (
          <Pill label="Open phone settings" onPress={() => { Linking.openSettings().catch(() => {}); }} testID="open-os-settings" />
        ) : (
          <Pill label="Open settings" onPress={onSettings} testID="open-settings" />
        )}
        <Pill label="Try again" onPress={onRetry} on testID="retry" />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  island: { height: 34, paddingHorizontal: 16, borderRadius: 999, backgroundColor: "rgba(6,12,52,0.62)", flexDirection: "row", alignItems: "center", gap: 9 },
  islandDot: { width: 6, height: 6, borderRadius: 6, backgroundColor: "#fff" },
  islandTxt: { color: "#fff", fontSize: 13, fontWeight: "500", fontFamily: fontMedium },
  card: { flex: 1, minHeight: 0, marginHorizontal: 14, borderRadius: 28, overflow: "hidden", backgroundColor: "#10208a" },
  loading: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingTxt: { color: "rgba(255,255,255,0.8)", fontSize: 14, fontFamily: font },
  foot: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, gap: 10 },
  warn: { color: "#ffe3b3", fontSize: 12.5, lineHeight: 17, fontFamily: font },
  sheet: { backgroundColor: colors.paper2, borderRadius: 24, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 15, gap: 4 },
  sheetLbl: { color: "#7a82b0", fontSize: 11.5, fontWeight: "600", letterSpacing: 0.6, textTransform: "uppercase", fontFamily: fontMedium },
  sentence: { color: colors.inkBlue, fontSize: 22, lineHeight: 27, fontWeight: "500", letterSpacing: -0.4, fontFamily: fontMedium, minHeight: 54 },
  placeholder: { color: "#9aa1c4", fontSize: 17, lineHeight: 23 },
  acts: { flexDirection: "row", gap: 8, justifyContent: "center" },
  speak: { minHeight: 48, minWidth: 160, paddingHorizontal: 28, borderRadius: 999, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  speakTxt: { color: colors.inkBlue, fontSize: 16, fontWeight: "500", letterSpacing: -0.16, fontFamily: fontMedium },
  credit: { color: "rgba(255,255,255,0.55)", fontSize: 11, fontFamily: font, textAlign: "center" },
  problem: { flex: 1, justifyContent: "center", paddingHorizontal: 18, gap: 18 },
  pcard: { backgroundColor: colors.paper2, borderRadius: 26, padding: 22, gap: 10 },
  ptitle: { color: colors.inkBlue, fontSize: 22, lineHeight: 27, fontWeight: "600", letterSpacing: -0.5, fontFamily: fontMedium },
  pbody: { color: "#4a5288", fontSize: 15, lineHeight: 21, fontFamily: font },
  urlBox: { marginTop: 4, backgroundColor: "rgba(31,63,214,0.07)", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 4 },
  urlTxt: { color: colors.inkBlue, fontSize: 13, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, Consolas, monospace" }) },
  urlDetail: { color: "#7a82b0", fontSize: 12, fontFamily: font },
});
