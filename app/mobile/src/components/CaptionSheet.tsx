// Caption sheet, as the web app's transcript box: the serif on a soft white fill. Words appear as heard (muted ink),
// go solid when signed; the word being signed gets the accent highlight with white type. Words without a sign stay
// muted and are never shown as signed. The sheet keeps the newest lines in view (it rolls up like the web's .roll).
import { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import type { WordState } from "@flux/core";
import { colors, serif } from "../theme";

interface Props {
  words: string[];
  states: WordState[];
  unsigned: Set<number>;
  lines?: number;
  fontSize?: number;
}

export function CaptionSheet({ words, states, unsigned, lines = 3, fontSize = 22 }: Props) {
  const lh = Math.round(fontSize * 1.24);
  const ys = useRef<number[]>([]);
  const sv = useRef<ScrollViewInstance>(null);
  const nowIdx = states.indexOf("now");
  let lastShown = -1;
  states.forEach((s, i) => { if (s !== "upcoming") lastShown = i; });
  const focus = nowIdx >= 0 ? Math.max(nowIdx, Math.min(lastShown, nowIdx + 3)) : lastShown;

  useEffect(() => {
    const y = ys.current[Math.max(0, focus)] ?? 0;
    sv.current?.scrollTo({ y: Math.max(0, y - (lines - 1) * lh), animated: true });
  }, [focus, lines, lh, words.length]);

  return (
    <View style={s.sheet}>
      <ScrollView ref={sv} style={{ height: lines * lh }} scrollEnabled={false} showsVerticalScrollIndicator={false}>
        <View style={s.flow} accessibilityLiveRegion="polite">
          {words.map((w, i) => {
            const st = states[i] ?? "upcoming";
            const no = unsigned.has(i);
            const now = st === "now";
            return (
              <View key={i} onLayout={(e) => { ys.current[i] = e.nativeEvent.layout.y; }}
                style={[s.word, { height: lh }, now && s.nowBox]}>
                <Text
                  style={[
                    s.txt, { fontSize, lineHeight: lh - 2 },
                    st === "upcoming" && { opacity: 0 },
                    st === "heard" && { color: colors.capHeard, opacity: 0.8 },
                    now && { color: colors.white },
                    no && st !== "upcoming" && s.unsigned,
                  ]}
                  accessibilityLabel={no ? `${w} (no sign yet)` : w}>
                  {w}
                </Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  sheet: { backgroundColor: colors.capBg, borderRadius: 22, borderWidth: 1, borderColor: colors.hair, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 13 },
  flow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center" },
  word: { paddingHorizontal: 3, marginRight: 2, borderRadius: 10, justifyContent: "center" },
  nowBox: { backgroundColor: colors.accent, borderWidth: 1, borderColor: "rgba(255,255,255,0.25)" },
  txt: { color: colors.label, fontFamily: serif, fontWeight: "500", letterSpacing: -0.3 },
  unsigned: { color: colors.label3, opacity: 1, textDecorationLine: "underline", textDecorationStyle: "dotted", textDecorationColor: colors.label3 },
});
