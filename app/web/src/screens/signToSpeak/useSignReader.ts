// Segmentation + recognition: the rest-based segmenter (lib/segmenter.ts on app/core/src/segment.ts) cuts signs out of
// the landmark stream while `reading`; every segment goes to POST /api/recognize. Requests run in parallel and their
// signs are appended in segment order; fresh() (Clear, Pause, a spoken sentence) bumps the epoch, so the still-pending
// ones never land in the next sentence.
import { useCallback, useEffect, useRef, useState } from "react";
import type { HolisticFrame, RecognizeMode, SignClient } from "@flux/core";
import { SPELL_SEG, createSegmenter, type SegState, type SegmentDone } from "../../lib/segmenter";
import { dejunk } from "../../lib/junk";
import { debugStats } from "../../lib/debug";
import { END_LAG_MS, LOW, MIN_CONF, NOT_SURE } from "./config";
import type { Entry } from "./words";

/** When the hands stopped (last motion, or last seen when they left the frame) and whether they left. */
export interface RestInfo { since: number; gone: boolean }
/** Closed vocabulary (sign mode): the profile's personal model over these signs. */
export interface Closed { on: boolean; profile: string; vocab: string[] }

export function useSignReader({ client, mode, reading, closed, fpsRef, setHint, onError, onOk }: {
  client: SignClient;
  mode: RecognizeMode;
  /** Camera and hand tracking ready, not paused. */
  reading: boolean;
  closed: Closed;
  fpsRef: { readonly current: number };
  setHint: (h: string | null) => void;
  onError: (e: unknown) => void;
  /** A recognize call came back (clears the error banner). */
  onOk: () => void;
}) {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const cbs = useRef({ setHint, onError, onOk });
  cbs.current = { setHint, onError, onOk };

  const [items, setItems] = useState<Entry[]>([]);
  const [seg, setSeg] = useState<SegState>("idle");
  const [pending, setPending] = useState(0);
  /** The rest timer counts from here. */
  const [restFrom, setRestFrom] = useState<RestInfo>({ since: 0, gone: false });

  const order = useRef({ seq: 0, next: 1, epoch: 0, done: new Map<number, { epoch: number; entries: Entry[] }>() });
  const flush = useCallback(() => {
    const o = order.current;
    const add: Entry[] = [];
    while (o.done.has(o.next)) {
      const r = o.done.get(o.next)!;
      o.done.delete(o.next++);
      if (r.epoch === o.epoch) add.push(...r.entries);
    }
    if (add.length) setItems((xs) => [...xs, ...add]);
  }, []);

  const onSegment = useCallback(async (s: SegmentDone) => {
    setRestFrom({ since: performance.now() - END_LAG_MS, gone: s.reason === "gone" });
    if (!s.count) return; // a twitch, or the hands going back to rest: keep reading
    const o = order.current;
    const id = ++o.seq, epoch = o.epoch;
    const entries: Entry[] = [];
    setPending((n) => n + 1);
    const m = modeRef.current;
    const t0 = performance.now();
    try {
      const cv = closedRef.current;
      const r = await client.recognize(m, s.frames, m === "sign" && cv.on ? { profile: cv.profile, vocab: cv.vocab, fps: fpsRef.current } : {});
      if (!alive.current) return;
      debugStats({ last: r, frames: s.count, segMs: Math.round(s.ms), reason: s.reason, rtMs: Math.round(performance.now() - t0) });
      cbs.current.onOk();
      if (m === "spell") {
        const word = (r.text ?? "").replace(/[^A-Za-z' -]/g, "").trim();
        if (word) entries.push({ label: `#${word.toUpperCase()}` });
      } else if (r.signs) {
        // closed vocabulary: every sign the server found in this segment; "unsure" ones are dropped
        let unsure = false;
        for (const g of r.signs) if (!g.reject && g.options.length) { entries.push({ label: g.options[0]!.label, options: g.options, sel: 0 }); unsure = Boolean(g.unsure); }
        const last = entries[entries.length - 1];
        if (epoch === o.epoch) cbs.current.setHint(!last ? null : unsure || last.options![0]!.confidence < LOW ? NOT_SURE : null);
      } else {
        const options = r.reject ? [] : dejunk(r.options).filter((x) => x.confidence >= MIN_CONF); // no sign / junk / too unsure -> nothing
        if (options.length) {
          entries.push({ label: options[0]!.label, options, sel: 0 });
          if (epoch === o.epoch) cbs.current.setHint(options[0]!.confidence < LOW ? NOT_SURE : null);
        }
      }
    } catch (e) {
      if (alive.current) cbs.current.onError(e);
    } finally {
      if (alive.current) {
        o.done.set(id, { epoch, entries });
        flush();
        setPending((n) => n - 1);
      }
    }
  }, [client, flush, fpsRef]);

  const onSegmentRef = useRef(onSegment);
  onSegmentRef.current = onSegment;
  const segRef = useRef<ReturnType<typeof createSegmenter> | null>(null);
  if (!segRef.current) segRef.current = createSegmenter((s) => void onSegmentRef.current(s), (s) => alive.current && setSeg(s));

  // Fingerspelling holds each letter: only a long pause ends a word there.
  useEffect(() => { segRef.current!.configure(mode === "spell" ? SPELL_SEG : {}); }, [mode]);

  // Camera on => always reading (until Pause).
  useEffect(() => {
    const sg = segRef.current!;
    if (reading) { if (sg.state === "idle") sg.arm(); }
    else sg.cancel();
  }, [reading]);

  const push = useCallback((f: HolisticFrame, t: number) => segRef.current!.push(f, t), []);
  /** Start a new sentence: drop the signs, and the answers still on their way. */
  const fresh = useCallback(() => { order.current.epoch++; setItems([]); }, []);
  const epoch = useCallback(() => order.current.epoch, []);

  return { items, setItems, seg, pending, restFrom, push, fresh, epoch };
}
