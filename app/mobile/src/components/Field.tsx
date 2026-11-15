import type { ReactNode } from "react";
import { ImageBackground, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Defs, Ellipse, RadialGradient, Stop } from "react-native-svg";
import { liveGradient } from "../theme";

const noise = require("../../assets/noise.png");

/** Film grain over everything below it (tiled PNG; the prototype uses SVG feTurbulence + soft-light). */
export function Grain({ opacity = 0.55 }: { opacity?: number }) {
  return <ImageBackground source={noise} resizeMode="repeat" style={[StyleSheet.absoluteFill, { opacity }]} imageStyle={{ resizeMode: "repeat" }} pointerEvents="none" />;
}

/** The live/home field (".g.live"): cobalt top to periwinkle bottom, a soft glow in the upper middle, a deep pool bottom left, grain on top. */
export function Field({ children }: { children?: ReactNode }) {
  return (
    <View style={s.root}>
      <LinearGradient colors={[...liveGradient]} locations={[0, 0.38, 0.7, 1]} style={StyleSheet.absoluteFill} />
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100" pointerEvents="none">
        <Defs>
          <RadialGradient id="glow" cx="50" cy="34" rx="60" ry="38" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#7896ff" stopOpacity={0.55} />
            <Stop offset="0.7" stopColor="#7896ff" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="pool" cx="20" cy="100" rx="70" ry="40" gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#0c228f" stopOpacity={1} />
            <Stop offset="0.7" stopColor="#0c228f" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx="50" cy="34" rx="60" ry="38" fill="url(#glow)" />
        <Ellipse cx="20" cy="100" rx="70" ry="40" fill="url(#pool)" />
      </Svg>
      <Grain />
      {children}
    </View>
  );
}

const s = StyleSheet.create({ root: { flex: 1, backgroundColor: "#1f3fd6", overflow: "hidden" } });
