// The sentence for the signs so far, and when it is spoken. With the server's OpenAI layer (health.compose), every new
// sign asks POST /api/compose in the background (top-3 guesses with scores + the session's conversation from
// lib/chat.ts; stale calls are aborted). Nothing is spoken while the signer is still signing: once the hands have
// rested REST_MS (or left the frame) and no segment is still being read, the model's sentence for exactly these signs
// is spoken once, waiting up to WAIT_MS for it, else the local composeSentence. At CAP signs it is spoken anyway.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SignApiError, labelText, type SignClient } from "@flux/core";
import type { SegState } from "../../lib/segmenter";
import { readHeard } from "../../lib/heard";
import { recentHistory } from "../../lib/chat";
import { CAP, HISTORY_TURNS, REST_MS, TOP_OPTIONS, WAIT_MS } from "./config";
import type { RestInfo } from "./useSignReader";
import { fixedSentence, keyOf, localSentence, wordOf, type Entry } from "./words";

/** A typed edit of the sentence: `text` replaces the signs before index `at`. */
export interface Edit { text: string; at: number }

export function useSentence({ client, items, epoch, freshSigns, seg, pending, restFrom, paused, editing, edit, setEdit, setHint, speakText, said }: {
  client: SignClient;
  items: Entry[];
  epoch: () => number;
  /** Drop the signs (useSignReader's fresh). */
  freshSigns: () => void;
  seg: SegState;
  /** Segments still being read. */
  pending: number;
  restFrom: RestInfo;
  paused: boolean;
  /** The sentence box has focus. */
  editing: boolean;
  edit: Edit | null;
  setEdit: (e: Edit | null) => void;
  setHint: (h: string | null) => void;
  speakText: (text: string) => void;
  said: { readonly current: string[] };
}) {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  /** Model sentence for the exact signs it was asked about (key = epoch + labels); null until it answers. */
  const [composed, setComposed] = useState<{ key: string; sentence: string } | null>(null);
  const composedRef = useRef<{ key: string; sentence: string } | null>(null);
  const [composing, setComposing] = useState(false);
  /** Off when health says compose is off, or the server answers 404 / 503. */
  const aiOn = useRef(true);
  const [aiFailed, setAiFailed] = useState(false);
  /** Set while the hands are at rest and we wait for the model's sentence for exactly these signs (keyOf). */
  const restKey = useRef<string | null>(null);
  const lastSpoken = useRef("");

  const sentence = useMemo(() => {
    if (!edit) return composed?.sentence && composed.key === keyOf(epoch(), items) ? composed.sentence : localSentence(items);
    const rest = items.slice(edit.at).map((x) => wordOf(x.label));
    if (!rest.length) return edit.text;
    const base = edit.text.trim().replace(/[.?!]+$/, "");
    return base ? `${base} ${rest.join(" ")}.` : localSentence(items.slice(edit.at));
  }, [items, edit, composed, epoch]);

  /** Start a fresh sentence (Clear, or after speaking). */
  const fresh = useCallback(() => { freshSigns(); setEdit(null); setHint(null); }, [freshSigns, setEdit, setHint]);

  /** Speak the sentence and start a fresh one. The same text twice in a row is not spoken again. */
  const speak = () => {
    const text = sentence.trim();
    if (!text) return;
    if (text !== lastSpoken.current) { lastSpoken.current = text; speakText(text); }
    fresh();
  };
  const speakRef = useRef(speak);
  speakRef.current = speak;

  /** Speak a finished sentence and start fresh (same text twice in a row is not repeated). */
  const autoSpeak = useCallback((text: string) => {
    restKey.current = null;
    if (text && text !== lastSpoken.current) { lastSpoken.current = text; speakText(text); }
    fresh();
  }, [speakText, fresh]);

  // Every new sign -> ask for the sentence in the background (aborting the stale call). It is only spoken at rest
  // (below); if the hands are already resting and waiting for exactly this answer, it is spoken now.
  useEffect(() => {
    if (!aiOn.current || aiFailed || paused || editing || edit || !items.length || fixedSentence(items)) return;
    const key = keyOf(epoch(), items);
    const ctrl = new AbortController();
    setComposing(true);
    const heard = readHeard();
    const history = recentHistory(HISTORY_TURNS);
    const context = said.current.length || heard || history.length
      ? { ...(said.current.length ? { said: said.current } : {}), ...(heard ? { heard } : {}), ...(history.length ? { history } : {}) }
      : undefined;
    const signs = items.map((x) => ({
      text: wordOf(x.label),
      ...(x.fixed ? { options: [{ text: wordOf(x.label), confidence: 1 }] }
        : x.options ? { options: x.options.slice(0, TOP_OPTIONS).map((o) => ({ text: o.text || labelText(o.label), confidence: o.confidence })) } : {}),
    }));
    client.compose({ signs, ...(context ? { context } : {}) }, ctrl.signal)
      .then((r) => {
        if (!alive.current || ctrl.signal.aborted || keyOf(epoch(), items) !== key) return;
        const sentence = r.sentence.trim();
        composedRef.current = { key, sentence };
        setComposed({ key, sentence });
        if (restKey.current === key) {
          if (sentence) autoSpeak(sentence);
          else restKey.current = null; // every sign dropped as noise: keep them on screen, nothing to say
        }
      })
      .catch((e) => {
        if (!alive.current || ctrl.signal.aborted) return;
        if (e instanceof SignApiError && (e.status === 404 || e.status === 503)) aiOn.current = false;
        setAiFailed(true); // this sentence falls back to the local rules; the next one tries the model again
      })
      .finally(() => { if (!ctrl.signal.aborted && alive.current) setComposing(false); });
    return () => { ctrl.abort(); setComposing(false); };
  }, [items, paused, editing, edit, client, autoSpeak, aiFailed, epoch, said]);
  useEffect(() => { if (!items.length) { setAiFailed(false); setComposed(null); composedRef.current = null; } }, [items]);

  // Speak on rest: hands still ~REST_MS and nothing still being read (or CAP signs) -> the model's sentence for exactly
  // these signs; if it isn't back yet, wait up to WAIT_MS for it, then the local composeSentence. After an edit, the
  // edited sentence (plus any signs since) is spoken at rest once something new was signed.
  useEffect(() => {
    if (paused || editing || !items.length) return;
    if (edit && items.length <= edit.at) return; // only the typed edit: the signer presses Speak
    const full = items.length >= CAP;
    if (!full && (seg === "recording" || pending > 0)) return;
    const key = keyOf(epoch(), items);
    const local = localSentence(items);
    let waitT = 0;
    const restT = window.setTimeout(() => {
      if (edit) { speakRef.current(); return; }
      const fixed = fixedSentence(items); // known phrases are always worded the same, no model call
      if (fixed) { autoSpeak(fixed); return; }
      if (!aiOn.current || aiFailed) { autoSpeak(local); return; }
      const c = composedRef.current;
      if (c?.key === key) { if (c.sentence) autoSpeak(c.sentence); return; }
      restKey.current = key; // the compose answer speaks as soon as it lands...
      waitT = window.setTimeout(() => { if (restKey.current === key) autoSpeak(local); }, WAIT_MS); // ...or not
    }, full || restFrom.gone ? 0 : Math.max(0, REST_MS - (performance.now() - restFrom.since))); // hands left the frame: at once
    return () => { clearTimeout(restT); clearTimeout(waitT); if (restKey.current === key) restKey.current = null; };
  }, [items, seg, pending, paused, editing, edit, restFrom, aiFailed, autoSpeak, epoch]);

  return { sentence, composing, speak, fresh, aiOn };
}
