// Caption sheet: words appear as heard, go solid when signed; the word being signed gets a tinted
// highlight in the speaker's colour. Words without a sign stay muted and are never shown as signed.
// The sheet keeps the newest lines in view (it rolls up like the prototype's .roll).
import { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import type { WordState } from "@signlayer/core";
import { colors, fontMedium, shadow, spk } from "../theme";

interface Props {
  words: string[];
  states: WordState[];
  unsigned: Set<number>;
  lines?: number;
  fontSize?: number;
}

export function CaptionSheet({ words, states, unsigned, lines = 3, fontSize = 22 }: Props) {
  const lh = Math.round(fontSize * 1.22);
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
    <View style={[s.sheet, shadow(18, 40, "rgba(5,15,90,0.45)")]}>
      <ScrollView ref={sv} style={{ height: lines * lh }} scrollEnabled={false} showsVerticalScrollIndicator={false}>
        <View style={s.flow} accessibilityLiveRegion="polite">
          {words.map((w, i) => {
            const st = states[i] ?? "upcoming";
            const no = unsigned.has(i);
            const now = st === "now";
            return (
              <View key={i} onLayout={(e) => { ys.current[i] = e.nativeEvent.layout.y; }}
                style={[s.word, { height: lh }, now && { backgroundColor: "rgba(47,85,255,0.14)", borderBottomColor: spk.spk, borderBottomWidth: 2 }]}>
                <Text
                  style={[
                    s.txt, { fontSize, lineHeight: lh - 2 },
                    st === "upcoming" && { opacity: 0 },
                    st === "heard" && { opacity: 0.5 },
                    now && { color: spk.spk },
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
  sheet: { backgroundColor: colors.paper2, borderRadius: 24, paddingHorizontal: 18, paddingTop: 13, paddingBottom: 15 },
  flow: { flexDirection: "row", flexWrap: "wrap" },
  word: { paddingHorizontal: 3, marginRight: 3, borderRadius: 7, justifyContent: "center" },
  txt: { color: colors.inkBlue, fontFamily: fontMedium, fontWeight: "500", letterSpacing: -0.4 },
  unsigned: { color: "#8c93bd", opacity: 0.8, textDecorationLine: "underline", textDecorationStyle: "dotted", textDecorationColor: "#aab0d6" },
});
