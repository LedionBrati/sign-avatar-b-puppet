// Mobile-side theme: the shared Flux tokens (the web app's light look) plus the few React Native specifics
// (fonts, shadows).
import { Platform } from "react-native";
import { colors } from "@flux/core";

export { colors, blooms, copy, waveColors, radii } from "@flux/core";

export const font = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: '"Inter Tight", Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
});
export const fontMedium = Platform.select({ android: "sans-serif-medium", default: font });
/** The serif for the wordmark, the transcript and the few display words (Newsreader on the web). */
export const serif = Platform.select({ ios: "Georgia", android: "serif", default: 'Newsreader, "Iowan Old Style", "Palatino Linotype", Georgia, serif' });

export const shadow = (y: number, blur: number, color: string, opacity = 1) =>
  Platform.select({
    web: { boxShadow: `0 ${y}px ${blur}px ${color}` } as object,
    default: { shadowColor: color, shadowOffset: { width: 0, height: y }, shadowRadius: blur / 2, shadowOpacity: opacity, elevation: Math.round(blur / 4) },
  });

/** The soft violet shadow under glass: small for pills and buttons (--shadow-1), large for cards and sheets (--shadow-2). */
export const glassShadow = (large = false) => large
  ? shadow(26, 64, `rgba(${colors.shadow},0.3)`)
  : shadow(10, 30, `rgba(${colors.shadow},0.24)`);

/** The glow under an accent button. */
export const accentShadow = shadow(10, 26, "rgba(91,92,240,0.45)");
