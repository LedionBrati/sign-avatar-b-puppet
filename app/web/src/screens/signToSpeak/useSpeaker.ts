// Speaking a sentence: one POST /api/speak (natural voice) per phrase on one reused <audio> (lib/voice.ts), else the
// device voice (speechSynthesis), only when the server has no natural voice at all. Embedded in the phone app, the
// app speaks it instead. Every spoken sentence joins the session's conversation (lib/chat.ts) and the "Said" sheet.
import { useCallback, useEffect, useRef, useState } from "react";
import { SignApiError, type SignClient } from "@flux/core";
import { addTurn } from "../../lib/chat";
import { playVoice, stopVoice, unlockVoice } from "../../lib/voice";
import { SAID_CONTEXT, SAID_HISTORY, SPEAK_CHAR_MS, SPEAK_MS, VOICE_MS } from "./config";
import { postToApp } from "./embed";

export function useSpeaker({ client, embed, setHint }: { client: SignClient; embed: boolean; setHint: (h: string | null) => void }) {
  const alive = useRef(true);
  const hintRef = useRef(setHint);
  hintRef.current = setHint;
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [lastSaid, setLastSaid] = useState(""); // the last spoken sentence stays visible in the empty box
  const [history, setHistory] = useState<string[]>([]);
  /** The last sentences this screen spoke, oldest first (context for the model). */
  const said = useRef<string[]>([]);
  /** Natural voice (POST /api/speak); off when health says speak is off, or 404 / 503. */
  const voiceOn = useRef(true);
  const pendingVoice = useRef<{ blob: Blob; done: () => void } | null>(null);
  const speakTimer = useRef(0);

  // A natural voice the browser refused to play (no tap yet) plays on the next tap.
  useEffect(() => {
    const onTap = () => {
      unlockVoice();
      const p = pendingVoice.current;
      if (p) { pendingVoice.current = null; hintRef.current(null); void playVoice(p.blob, p.done).catch(() => {}); }
    };
    addEventListener("pointerdown", onTap);
    return () => removeEventListener("pointerdown", onTap);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; stopVoice(); };
  }, []);

  // The camera screen speaks without a gesture: unlock the audio element on the first tap / click / key anywhere.
  useEffect(() => {
    if (embed) return;
    const on = () => unlockVoice();
    addEventListener("pointerdown", on, { capture: true });
    addEventListener("keydown", on, { capture: true });
    return () => { removeEventListener("pointerdown", on, { capture: true }); removeEventListener("keydown", on, { capture: true }); };
  }, [embed]);

  const speakText = useCallback((text: string) => {
    setLastSaid(text);
    const done = () => { if (alive.current) setSpeaking((x) => (x === text ? null : x)); };
    const robot = () => {
      if (!("speechSynthesis" in window)) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      const voice = speechSynthesis.getVoices().find((v) => v.lang === "en-US");
      if (voice) u.voice = voice;
      u.onend = u.onerror = done;
      speechSynthesis.speak(u);
    };
    if (embed) postToApp({ type: "speak", text });
    else if (voiceOn.current) {
      client.speak(text, { signal: AbortSignal.timeout(VOICE_MS) }) // exactly one /api/speak per spoken phrase
        .then((blob) => {
          if (!alive.current) return;
          return playVoice(blob, done).catch(() => {
            // Browser blocked sound (no tap yet): never fall back to the robot voice, hold the natural voice and play
            // it on the next tap.
            pendingVoice.current = { blob, done };
            hintRef.current("Tap anywhere to turn on the voice.");
          });
        })
        .catch((e) => {
          if (e instanceof SignApiError && (e.status === 404 || e.status === 503)) voiceOn.current = false;
          if (alive.current && !voiceOn.current) robot(); // only when the server has no natural voice at all
        });
    } else robot();
    setSpeaking(text);
    clearTimeout(speakTimer.current);
    speakTimer.current = window.setTimeout(done, SPEAK_MS + text.length * SPEAK_CHAR_MS);
    said.current = [...said.current, text].slice(-SAID_CONTEXT);
    addTurn("me", text); // the session's conversation (Live adds what the hearing person said)
    setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, SAID_HISTORY));
  }, [embed, client]);

  return { speakText, speaking, lastSaid, history, said, voiceOn };
}
