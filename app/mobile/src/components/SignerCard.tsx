// Frosted signer card: the avatar video sits in a radial vignette that fades into the card colour
// (React Native has no CSS mask-image, so the vignette is an SVG radial gradient over the video),
// a speaker chip on top, and the caption sheet docked at the bottom.
import { useState, type ReactNode } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { cardBase, shadow, spk, fontMedium } from "../theme";
import { Grain } from "./Field";

export function SignerCard({ video, caption, speaking, notice }: { video: ReactNode; caption: ReactNode; speaking: boolean; notice?: ReactNode }) {
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => setStage({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  // Prototype: a square 128% of the stage height (capped); also capped by width so the whole vignette stays on the card.
  const size = Math.min(stage.h * 1.28, 560, stage.w * 1.3);
  return (
    <View style={[s.card, shadow(30, 70, spk.glow, 0.55)]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: cardBase }]} />
      <View style={s.stage} onLayout={onLayout}>
        {notice ? <View style={s.notice}>{notice}</View> : stage.h > 0 && (
          <View style={{ position: "absolute", width: size, height: size, left: (stage.w - size) / 2, top: stage.h * 0.54 - size / 2, overflow: "hidden" }}>
            {video}
            <Svg style={{ position: "absolute", left: -3, top: -3 }} width={size + 6} height={size + 6} pointerEvents="none">
              <Defs>
                <RadialGradient id="vig" cx="0.5" cy="0.48" rx="0.42" ry="0.46" fx="0.5" fy="0.48" gradientUnits="objectBoundingBox">
                  <Stop offset="0.6" stopColor={cardBase} stopOpacity={0} />
                  <Stop offset="0.84" stopColor={cardBase} stopOpacity={0.8} />
                  <Stop offset="0.95" stopColor={cardBase} stopOpacity={1} />
                </RadialGradient>
              </Defs>
              <Rect x={0} y={0} width={size + 6} height={size + 6} fill="url(#vig)" />
            </Svg>
          </View>
        )}
      </View>
      {/* Sheen + floor shade over the whole card (video included) so the vignette edge never shows. */}
      <LinearGradient pointerEvents="none" colors={["rgba(255,255,255,0.22)", "rgba(255,255,255,0)"]} locations={[0, 0.2]} style={StyleSheet.absoluteFill} />
      <LinearGradient pointerEvents="none" colors={["rgba(5,15,90,0)", "rgba(5,15,90,0.22)"]} locations={[0.55, 1]} style={StyleSheet.absoluteFill} />
      <Grain opacity={0.3} />
      <View style={s.chip}>
        <View style={s.dot} />
        <Text style={s.chipTxt}>Speaker 1{speaking ? <Text style={{ opacity: 0.8 }}> · Speaking</Text> : null}</Text>
      </View>
      <View style={s.cap}>{caption}</View>
      <View pointerEvents="none" style={s.edge} />
    </View>
  );
}

const s = StyleSheet.create({
  card: { flex: 1, borderRadius: 32, overflow: "hidden", backgroundColor: cardBase },
  stage: { flex: 1, overflow: "hidden" },
  notice: { flex: 1, marginTop: 52, marginHorizontal: 22, marginBottom: 12, padding: 16, borderRadius: 20,
    backgroundColor: "rgba(246,247,251,0.94)" },
  chip: { position: "absolute", top: 12, left: 12, height: 28, borderRadius: 999, paddingLeft: 10, paddingRight: 12, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(47,85,255,0.82)" },
  dot: { width: 7, height: 7, borderRadius: 7, backgroundColor: "#fff" },
  chipTxt: { color: "#fff", fontSize: 12, fontWeight: "500", fontFamily: fontMedium },
  cap: { margin: 10, marginTop: 0 },
  edge: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 32, borderWidth: 1, borderColor: "rgba(255,255,255,0.22)" },
});
