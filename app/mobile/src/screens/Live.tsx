// Live screen: listen (or type) → each final phrase goes to /api/sign → clips are appended to the
// playlist → the signer card plays them back to back while the captions follow word by word.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { captionFrame, createSignClient, playlistSeconds, type SignResponse } from "@signlayer/core";
import { Field } from "../components/Field";
import { Mark } from "../components/Mark";
import { Pill } from "../components/Glass";
import { SignWave } from "../components/SignWave";
import { SignerCard } from "../components/SignerCard";
import { CaptionSheet } from "../components/CaptionSheet";
import { PlaylistPlayer } from "../components/PlaylistPlayer";
import { TypeBar } from "../components/TypeBar";
import { appendResponse, emptySession, unsignedWords } from "../lib/session";
import { canListen, startListening } from "../lib/speech";
import { keepAwake, tap } from "../lib/feedback";
import { copy, font, fontMedium } from "../theme";

interface Props {
  serverUrl: string;
  onExit: () => void;
  onSettings: () => void;
  /** Start in typed mode even if speech is available. */
  typed?: boolean;
}

export function Live({ serverUrl, onExit, onSettings, typed }: Props) {
  const client = useMemo(() => createSignClient(serverUrl), [serverUrl]);
  const [session, setSession] = useState<SignResponse>(emptySession);
  const [playing, setPlaying] = useState(-1);
  const [runKey, setRunKey] = useState(0);
  const [pending, setPending] = useState(0);
  const [interim, setInterim] = useState("");
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);

  // Phrases are signed in the order they were heard, even if a later request returns first.
  const sign = useCallback((text: string) => {
    setPending((n) => n + 1);
    setError(null);
    const req = client.sign({ text });
    queue.current = queue.current.then(async () => {
      try {
        const res = await req;
        if (alive.current) setSession((s) => appendResponse(s, res));
      } catch (e) {
        if (alive.current) setError(e instanceof Error && e.message ? `Can't reach the server (${e.message}).` : "Can't reach the server.");
      } finally {
        if (alive.current) setPending((n) => n - 1);
      }
    });
  }, [client]);

  const listen = useCallback(async () => {
    if (!canListen || typed) return;
    const stop = await startListening({
      onInterim: (t) => setInterim(t),
      onFinal: (t) => { setInterim(""); sign(t); },
      onError: (m) => setError(m),
      onEnd: () => setListening(false),
    });
    stopRef.current = stop;
    setListening(!!stop);
  }, [sign, typed]);

  useEffect(() => {
    alive.current = true;
    keepAwake(true);
    tap("start");
    listen();
    return () => { alive.current = false; stopRef.current?.(); keepAwake(false); };
  }, [listen]);

  const stopListening = () => { stopRef.current?.(); stopRef.current = null; setListening(false); };
  const stop = () => { tap("stop"); stopListening(); onExit(); };
  const again = () => { tap("start"); setSession(emptySession()); setPlaying(-1); setRunKey((k) => k + 1); setInterim(""); setError(null); listen(); };
  const replay = () => { tap("light"); setPlaying(-1); setRunKey((k) => k + 1); };

  const n = session.playlist.length;
  const frame = captionFrame(session, session.words.length, playing);
  const unsigned = useMemo(() => unsignedWords(session), [session]);
  const hasWords = session.words.length > 0;
  const caughtUp = n === 0 ? hasWords : playing >= n;
  const done = hasWords && !listening && pending === 0 && caughtUp;
  const showCard = hasWords;
  const cur = frame.current >= 0 ? session.playlist[frame.current] : undefined;
  const nowWord = cur && cur.word_index >= 0 ? session.words[cur.word_index]?.replace(/[.,:;!?]+$/, "") : undefined;

  const island = done ? "1 speaker · Done" : showCard ? "1 speaker" : listening ? "Listening" : canListen && !typed ? "Starting…" : "Type to sign";
  const heardLine = interim || (pending > 0 ? session.text || "…" : "");

  return (
    <Field>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom", "left", "right"]}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={s.bar}>
            <View style={{ flex: 1 }}><Mark size={28} /></View>
            <View style={s.island} testID="island">
              <View style={s.islandDot} />
              <Text style={s.islandTxt}>{island}</Text>
            </View>
            <View style={{ flex: 1, alignItems: "flex-end" }}>
              {!done && <Pill label="Stop" onPress={stop} testID="stop" />}
            </View>
          </View>

          <View style={s.middle}>
            {showCard ? (
              <SignerCard
                speaking={!done && frame.current >= 0}
                video={<PlaylistPlayer playlist={session.playlist} runKey={runKey} onIndex={setPlaying} />}
                caption={<CaptionSheet words={session.words} states={frame.states} unsigned={unsigned} lines={2} />}
              />
            ) : (
              <View style={s.listen}>
                <SignWave level={listening || pending > 0 ? 0.95 : 0.4} talking height={170} />
                <Text style={s.lbl}>{listening ? "Listening…" : pending > 0 ? "Signing…" : canListen && !typed ? "Starting the microphone…" : "Type something and it will be signed"}</Text>
                <Text style={s.heard} numberOfLines={3}>{heardLine}</Text>
              </View>
            )}
          </View>

          <View style={s.foot}>
            {showCard && interim ? <Text style={s.interim} numberOfLines={1}>{interim}</Text> : null}
            {!done && showCard && (
              <Text style={s.now} testID="nowline">
                {cur ? (
                  <>Signing <Text style={s.nowB}>{cur.gloss}</Text>{nowWord ? <Text style={s.for}> for “{nowWord}”</Text> : null}</>
                ) : n === 0 ? "No signs for these words yet" : listening ? "Listening…" : pending > 0 ? "Signing…" : ""}
              </Text>
            )}
            {done && (
              <>
                <Text style={s.sum} testID="summary">
                  <Text style={s.sumB}>Signed</Text> · {n} sign{n === 1 ? "" : "s"} · {Math.round(playlistSeconds(session))} s
                  {unsigned.size ? <Text style={{ opacity: 0.75 }}> · {unsigned.size} word{unsigned.size === 1 ? "" : "s"} without a sign yet</Text> : null}
                </Text>
                <View style={s.acts}>
                  <Pill label="Replay" onPress={replay} testID="replay" />
                  <Pill label="Listen again" onPress={again} on testID="again" />
                </View>
              </>
            )}
            {error ? (
              <Text style={s.err} onPress={onSettings}>{error} <Text style={{ textDecorationLine: "underline" }}>Server settings</Text></Text>
            ) : null}
            <TypeBar onSubmit={(t) => { tap("light"); sign(t); }} busy={pending > 0} autoFocus={!canListen && Platform.OS !== "web"} />
            {!canListen && !hasWords ? <Text style={s.hint}>Speech recognition needs a development build. Typing works everywhere.</Text> : null}
            <Text style={s.credit}>{copy.credit}</Text>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Field>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12 },
  island: { height: 34, paddingHorizontal: 16, borderRadius: 999, backgroundColor: "rgba(6,12,52,0.62)", flexDirection: "row", alignItems: "center", gap: 9 },
  islandDot: { width: 6, height: 6, borderRadius: 6, backgroundColor: "#fff" },
  islandTxt: { color: "#fff", fontSize: 13, fontWeight: "500", fontFamily: fontMedium },
  middle: { flex: 1, minHeight: 0, paddingHorizontal: 14 },
  listen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  lbl: { color: "#fff", opacity: 0.75, fontSize: 15, letterSpacing: -0.15, fontFamily: font },
  heard: { color: "#fff", fontSize: 27, fontWeight: "500", letterSpacing: -0.7, lineHeight: 32, textAlign: "center", paddingHorizontal: 28, minHeight: 96, fontFamily: fontMedium },
  foot: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, gap: 9 },
  interim: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontFamily: font },
  now: { color: "rgba(255,255,255,0.85)", fontSize: 13, fontFamily: font, minHeight: 18 },
  nowB: { fontWeight: "600", letterSpacing: 0.3, color: "#fff" },
  for: { opacity: 0.65 },
  sum: { color: "#fff", fontSize: 13, fontFamily: font },
  sumB: { fontWeight: "600" },
  acts: { flexDirection: "row", gap: 8 },
  err: { color: "#ffd9d9", fontSize: 13, fontFamily: font },
  hint: { color: "rgba(255,255,255,0.6)", fontSize: 12, fontFamily: font, textAlign: "center" },
  credit: { color: "rgba(255,255,255,0.45)", fontSize: 10, fontFamily: font },
});

