// Live screen: listen (or type) → each final phrase goes to /api/sign → clips are appended to the
// playlist → the signer card plays them back to back while the captions follow word by word.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { captionFrame, createSignClient, generatingLabel, playlistSeconds, type SignResponse } from "@flux/core";
import { Field } from "../components/Field";
import { Mark } from "../components/Mark";
import { Glass, Pill } from "../components/Glass";
import { SignWave } from "../components/SignWave";
import { SignerCard } from "../components/SignerCard";
import { CaptionSheet } from "../components/CaptionSheet";
import { PlaylistPlayer } from "../components/PlaylistPlayer";
import { TypeBar } from "../components/TypeBar";
import { appendResponse, emptySession, unsignedWords } from "../lib/session";
import { canListen, startListening } from "../lib/speech";
import { keepAwake, tap } from "../lib/feedback";
import { colors, copy, font, fontMedium, serif } from "../theme";

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
  const sessionRef = useRef<SignResponse>(emptySession());
  const failedRef = useRef(false);
  const [playing, setPlaying] = useState(-1);
  const [runKey, setRunKey] = useState(0);
  const [pending, setPending] = useState(0);
  const [interim, setInterim] = useState("");
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCaption, setErrorCaption] = useState("");
  const stopRef = useRef<(() => void) | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);

  // Phrases are signed in the order they were heard, even if a later request returns first.
  const sign = useCallback((text: string) => {
    setPending((n) => n + 1);
    setError(null);
    setErrorCaption("");
    const req = client.sign({ text });
    queue.current = queue.current.then(async () => {
      try {
        const res = await req;
        if (alive.current) {
          const blocked = res.safety && res.safety.status !== "fully_supported";
          const previousBlocked = failedRef.current || Boolean(sessionRef.current.safety && sessionRef.current.safety.status !== "fully_supported");
          const next = blocked || previousBlocked ? res : appendResponse(sessionRef.current, res);
          failedRef.current = false;
          sessionRef.current = next;
          setSession(next);
          if (blocked || previousBlocked) { setPlaying(-1); setRunKey((k) => k + 1); }
        }
      } catch (e) {
        if (alive.current) {
          const fallback = { ...emptySession(), text, words: text.trim().split(/\s+/) };
          sessionRef.current = fallback;
          failedRef.current = true;
          setSession(fallback);
          setPlaying(-1);
          setRunKey((k) => k + 1);
          setErrorCaption(text);
          setError(e instanceof Error && e.message ? `Can't reach the server (${e.message}).` : "Can't reach the server.");
        }
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
  const again = () => { tap("start"); sessionRef.current = emptySession(); failedRef.current = false; setSession(sessionRef.current); setPlaying(-1); setRunKey((k) => k + 1); setInterim(""); setError(null); setErrorCaption(""); listen(); };
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
  const blocked = Boolean(error) || Boolean(session.safety && session.safety.status !== "fully_supported");
  const safetyTitle = error ? "Signing unavailable" : session.safety?.status === "needs_confirmation" ? "Meaning needs confirmation" : "Caption only";

  const island = blocked ? safetyTitle : done ? "1 speaker · Done" : showCard ? "1 speaker" : listening ? "Listening" : canListen && !typed ? "Starting…" : "Type to sign";
  const heardLine = interim || (pending > 0 ? session.text || "…" : "");
  const generating = generatingLabel(session);   // "Generating SICK… ~2 min": the server is making the missing clip

  return (
    <Field>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom", "left", "right"]}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={s.bar}>
            <View style={{ flex: 1 }}><Mark size={28} /></View>
            <Glass tint={colors.island} style={s.island} testID="island">
              <View style={[s.islandDot, blocked && s.islandWarn]} />
              <Text style={s.islandTxt}>{island}</Text>
            </Glass>
            <View style={{ flex: 1, alignItems: "flex-end" }}>
              {!done && <Pill label="Stop" onPress={stop} testID="stop" />}
            </View>
          </View>

          <View style={s.middle}>
            {showCard ? (
              <SignerCard
                speaking={!done && frame.current >= 0}
                video={<PlaylistPlayer key={runKey} playlist={session.playlist} runKey={runKey} onIndex={setPlaying} />}
                caption={<View>
                  <CaptionSheet words={session.words} states={frame.states} unsigned={unsigned} lines={2} />
                  {generating ? <Text style={s.gen} testID="generating" accessibilityRole="text">{generating}</Text> : null}
                </View>}
                notice={error ? <>
                  <Text style={s.safetyTitle}>Signing unavailable</Text>
                  <Text style={s.safetyCaption}>{errorCaption}</Text>
                  <Text style={s.safetyReason}>The sign server could not be reached. Check the server settings and try again.</Text>
                </> : blocked && session.safety ? <>
                  <Text style={s.safetyTitle}>{safetyTitle}</Text>
                  <Text style={s.safetyCaption}>{session.safety.caption}</Text>
                  {session.safety.reasons.map((reason, i) => <Text key={i} style={s.safetyReason}>
                    {reason.tokens.length ? `${reason.tokens.join(", ")}: ` : ""}{reason.next_action}
                  </Text>)}
                </> : undefined}
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
                <Text style={s.sum} testID="summary">{blocked ? `${safetyTitle} · No signing for this message` : <>
                  <Text style={s.sumB}>Signed</Text> · {n} sign{n === 1 ? "" : "s"} · {Math.round(playlistSeconds(session))} s
                  {unsigned.size ? <Text style={{ opacity: 0.75 }}> · {unsigned.size} word{unsigned.size === 1 ? "" : "s"} without a sign yet</Text> : null}
                </>}</Text>
                <View style={s.acts}>
                  {!blocked ? <Pill label="Replay" onPress={replay} testID="replay" /> : null}
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
  island: { height: 36, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", gap: 9 },
  islandDot: { width: 8, height: 8, borderRadius: 8, backgroundColor: colors.cyan, borderWidth: 1, borderColor: "rgba(68,70,216,0.35)" },
  islandWarn: { backgroundColor: "#ffb340", borderColor: "rgba(180,100,0,0.3)" },
  islandTxt: { color: colors.label, fontSize: 14, fontWeight: "600", letterSpacing: -0.14, fontFamily: fontMedium },
  middle: { flex: 1, minHeight: 0, paddingHorizontal: 10 },
  listen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  lbl: { color: colors.label2, fontSize: 19, fontStyle: "italic", letterSpacing: -0.1, fontFamily: serif },
  heard: { color: colors.label, fontSize: 28, fontWeight: "500", letterSpacing: -0.4, lineHeight: 34, textAlign: "center", paddingHorizontal: 28, minHeight: 102, fontFamily: serif },
  foot: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, gap: 9 },
  interim: { color: colors.label2, fontSize: 13, fontStyle: "italic", fontFamily: font },
  now: { color: colors.label2, fontSize: 13, fontFamily: font, minHeight: 18 },
  nowB: { fontWeight: "700", letterSpacing: 0.5, color: colors.accent },
  for: { opacity: 0.8 },
  sum: { color: colors.label, fontSize: 13, fontFamily: font },
  sumB: { fontWeight: "600" },
  acts: { flexDirection: "row", gap: 8 },
  err: { color: "#b3261e", fontSize: 13, fontFamily: font },
  gen: { position: "absolute", right: 16, top: -11, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, overflow: "hidden",
    backgroundColor: colors.white, color: colors.accent, fontSize: 11, fontWeight: "600", fontFamily: fontMedium },
  hint: { color: colors.label2, fontSize: 12, fontFamily: font, textAlign: "center" },
  credit: { color: colors.label3, fontSize: 10, fontFamily: font },
  safetyTitle: { color: colors.warn, fontSize: 12, fontWeight: "700", letterSpacing: 1.4, textTransform: "uppercase", fontFamily: fontMedium },
  safetyCaption: { color: colors.label, fontSize: 23, lineHeight: 28, fontWeight: "500", marginTop: 12, marginBottom: 12, fontFamily: serif },
  safetyReason: { color: colors.label2, fontSize: 13, lineHeight: 18, marginBottom: 7, fontFamily: font },
});
