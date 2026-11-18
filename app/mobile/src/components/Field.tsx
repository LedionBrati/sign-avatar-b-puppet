import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Defs, Ellipse, RadialGradient, Stop } from "react-native-svg";
import { blooms, colors } from "../theme";

/** The app background, as the web app's light look (--bg-art): a soft paper wash, top to bottom, with pastel blooms
 *  (peach, pink, violet along the bottom, cyan up the right edge, a faint ice haze right of centre). */
export function Field({ children }: { children?: ReactNode }) {
  return (
    <View style={s.root}>
      <LinearGradient colors={[...colors.bgWash]} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100" pointerEvents="none">
        <Defs>
          {blooms.map((b, i) => (
            <RadialGradient key={i} id={`bloom${i}`} cx={b.x} cy={b.y} rx={b.rx} ry={b.ry} fx={b.x} fy={b.y} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={`rgb(${b.c})`} stopOpacity={b.a} />
              <Stop offset="0.36" stopColor={`rgb(${b.c})`} stopOpacity={b.a * 0.55} />
              <Stop offset="0.72" stopColor={`rgb(${b.c})`} stopOpacity={0} />
            </RadialGradient>
          ))}
        </Defs>
        {[...blooms].reverse().map((b, j) => {
          const i = blooms.length - 1 - j;   // first bloom on top, as in CSS
          return <Ellipse key={i} cx={b.x} cy={b.y} rx={b.rx} ry={b.ry} fill={`url(#bloom${i})`} />;
        })}
      </Svg>
      {children}
    </View>
  );
}

const s = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.bg, overflow: "hidden" } });
