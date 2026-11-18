import { Platform } from "react-native";
import * as Haptics from "expo-haptics";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

export const tap = (kind: "start" | "stop" | "light" = "light") => {
  if (Platform.OS === "web") return;
  const style = kind === "start" ? Haptics.ImpactFeedbackStyle.Medium : kind === "stop" ? Haptics.ImpactFeedbackStyle.Rigid : Haptics.ImpactFeedbackStyle.Light;
  Haptics.impactAsync(style).catch(() => {});
};

const TAG = "flux-live";
export const keepAwake = (on: boolean) => {
  if (on) activateKeepAwakeAsync(TAG).catch(() => {});
  else deactivateKeepAwake(TAG).catch(() => {});
};
