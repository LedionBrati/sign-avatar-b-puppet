// Signer card, as the web app's Live card (.fcard): white frosted glass holding the stage, a rounded panel in the
// signer clips' own studio backdrop. The avatar video sits in a radial vignette that fades into that backdrop
// (React Native has no CSS mask-image, so the vignette is an SVG radial gradient over the video), so the clip edge
// never shows. A speaker chip sits on the stage, and the caption sheet is docked under it inside the glass.
import { useState, type ReactNode } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { colors, fontMedium, radii } from "../theme";
import { Glass } from "./Glass";

/** The stage, and where the vignette lands: one flat tone, so the video's square never shows a seam against it. */
const STAGE = colors.stage;

export function SignerCard({ video, caption, speaking, notice }: { video: ReactNode; caption: ReactNode; speaking: boolean; notice?: ReactNode }) {
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => setStage({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  // A square 128% of the stage height (capped); also capped by width so the whole vignette stays on the stage.
  const size = Math.min(stage.h * 1.28, 560, stage.w * 1.3);
  return (
    <Glass radius={radii.card} large style={s.card}>
      <View style={[s.stage, notice ? s.stageOff : null]} onLayout={onLayout}>
        {notice ? <View style={s.notice}>{notice}</View> : stage.h > 0 && (
          <View style={{ position: "absolute", width: size, height: size, left: (stage.w - size) / 2, top: stage.h * 0.54 - size / 2, overflow: "hidden" }}>
            {video}
            <Svg style={{ position: "absolute", left: -3, top: -3 }} width={size + 6} height={size + 6} pointerEvents="none">
              <Defs>
                <RadialGradient id="vig" cx="0.5" cy="0.48" rx="0.42" ry="0.46" fx="0.5" fy="0.48" gradientUnits="objectBoundingBox">
                  <Stop offset="0.6" stopColor={STAGE} stopOpacity={0} />
                  <Stop offset="0.84" stopColor={STAGE} stopOpacity={0.8} />
                  <Stop offset="0.95" stopColor={STAGE} stopOpacity={1} />
                </RadialGradient>
              </Defs>
              <Rect x={0} y={0} width={size + 6} height={size + 6} fill="url(#vig)" />
            </Svg>
          </View>
        )}
        {/* the glass edge of the stage (.signer-card::after) */}
        {notice ? null : <View pointerEvents="none" style={s.stageEdge} />}
        {notice ? null : (
          <View style={s.chip}>
            <View style={s.dot} />
            <Text style={s.chipTxt}>Speaker 1{speaking ? <Text style={{ opacity: 0.75 }}> · Speaking</Text> : null}</Text>
          </View>
        )}
      </View>
      <View style={s.cap}>{caption}</View>
    </Glass>
  );
}

const s = StyleSheet.create({
  card: { flex: 1, padding: 10, gap: 10 },
  stage: { flex: 1, borderRadius: radii.stage, overflow: "hidden", backgroundColor: STAGE },
  stageOff: { backgroundColor: "transparent" },
  stageEdge: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: radii.stage, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)" },
  notice: { flex: 1, marginTop: 12, marginHorizontal: 6, marginBottom: 2, padding: 18, borderRadius: 18,
    backgroundColor: colors.fill2, borderWidth: 1, borderColor: colors.rim },
  chip: { position: "absolute", top: 12, left: 12, height: 30, borderRadius: 999, paddingLeft: 11, paddingRight: 13, flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "rgba(6,9,28,0.55)", borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  dot: { width: 7, height: 7, borderRadius: 7, backgroundColor: "#8ea6ff" },
  chipTxt: { color: "#fff", fontSize: 12.5, fontWeight: "600", fontFamily: fontMedium },
  cap: {},
});
