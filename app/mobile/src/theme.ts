// Mobile-side theme: the shared Flux tokens plus the few React Native specifics (fonts, shadows).
import { Platform } from "react-native";
import { colors, speakers } from "@flux/core";

export { colors, speakers, copy, liveGradient, waveColors, radii } from "@flux/core";

export const font = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Inter, Arial, sans-serif',
});
export const fontMedium = Platform.select({ android: "sans-serif-medium", default: font });

/** The card's own base colour: the vignette over the signer fades into exactly this, so the video edge disappears. */
export const cardBase = "#4561e2";

export const spk = speakers[0];

export const shadow = (y: number, blur: number, color: string, opacity = 1) =>
  Platform.select({
    web: { boxShadow: `0 ${y}px ${blur}px ${color}` } as object,
    default: { shadowColor: color, shadowOffset: { width: 0, height: y }, shadowRadius: blur / 2, shadowOpacity: opacity, elevation: Math.round(blur / 4) },
  });

export const ink = colors.inkBlue;
