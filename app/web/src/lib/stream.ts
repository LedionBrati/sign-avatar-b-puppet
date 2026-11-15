// Sliding-window sign reading with stable-peak decoding (sign mode; fingerspelling keeps the rest-based segmenter).
// A ring buffer keeps the last packed frames with hands. While the hands are visible and moving ("recording"), every
// STEP_MS the last ~WIN_MS of frames goes to /api/recognize (one request in flight at most; windows that come due
// while one is pending are dropped). A sign is accepted only when the same top label wins NEED consecutive windows,
// each with confidence >= MIN_CONF and a margin over #2 >= MIN_MARGIN. It is emitted once; the same label can only be
// emitted again after another label has led (LEAD_CHANGE windows) or the hands rested. When the hands rest or leave,
// the tail is read once more if no window covered it, then flushed: a label that led the last windows with decent
// confidence is emitted. State goes back to "armed" only after the flush, so "armed + nothing pending" = settled.
//
// Junk filter: windows with almost no hand motion are not sent, and toddler-vocabulary labels (DOWNWEIGHT) are removed
// from every window's guesses unless they are the only plausible guess at >= JUNK_KEEP_CONF.
import { handsVisible, packFrame, packSegment, type HolisticFrame, type RecognizeResponse } from "@signlayer/core";
import { motion, type SegState } from "./segmenter";

export const STREAM_CFG = {
  stepMs: 350, // a window every this often while signing
  winMs: 1000, // window length (~24-32 frames at 24-30 fps)
  winMax: 32, // frames per window, at most
  winMin: 8, // fewer frames -> wait
  firstMs: 400, // first window this long after the motion started
  preRollMs: 250, // a window never reaches further back than this before the motion started
  need: 2, // consecutive strong windows with the same top label to accept it
  minConf: 0.35, // a window is "strong" at this confidence...
  minMargin: 0.12, // ...with this lead over #2
  leadChange: 2, // windows another label must lead before the last emitted label can be emitted again
  flushConf: 0.3, // at rest: a label leading >= 2 of the last windows needs this peak confidence
  flushSingleConf: 0.5, // at rest: a label seen in only 1 window needs this (and minMargin)
  flushLook: 3, // at rest: how many of the last windows are looked at
  moveThresh: 0.006, // per-frame displacement counted as motion (same as the segmenter)
  minWinMotion: 0.0035, // junk filter: mean per-frame wrist+fingertip displacement over the window
  stillMs: 400, // hands still this long -> rest (flush)
  goneMs: 400, // hands gone this long -> rest (flush)
  minMs: 300, // a "still" rest never comes sooner than this after the motion started
  ringMax: 48, // frames kept
  junkKeepConf: 0.7, // a DOWNWEIGHT label survives only at this confidence...
  plausible: 0.1, // ...and no other (non-junk) guess at or above this
};

/** Toddler-vocabulary GISLR labels that the recognizer over-predicts on adult conversation: dropped unless they are
 *  the only plausible guess. (potty is not here: the sentence model reads it as "bathroom".) */
export const DOWNWEIGHT: readonly string[] = [
  "alligator", "animal", "balloon", "bee", "bird", "carrot", "cat", "chocolate", "clown", "cow", "cowboy", "donkey", "doll",
  "duck", "elephant", "fireman", "frenchfries", "frog", "giraffe", "goose", "gum", "hen", "horse", "kitty", "lion", "mitten",
  "owl", "owie", "penny", "pig", "puppy", "puzzle", "snack", "tiger", "vacuum", "wolf", "zebra", "zipper", "underwear",
];
const JUNK = new Set(DOWNWEIGHT.map((l) => l.toLowerCase()));
export const isJunk = (label: string) => JUNK.has(label.toLowerCase());

type Option = RecognizeResponse["options"][number];
export interface StreamSign { label: string; options: Option[]; reason: "stable" | "flush" }
export interface RestInfo { since: number; gone: boolean }

/** Sorted guesses without junk labels, unless the junk label is the only plausible guess with high confidence. */
export function dejunk(options: Option[]): Option[] {
  const sorted = [...options].sort((a, b) => b.confidence - a.confidence);
  const top = sorted[0];
  if (top && isJunk(top.label) && top.confidence >= STREAM_CFG.junkKeepConf
    && !sorted.some((o) => !isJunk(o.label) && o.confidence >= STREAM_CFG.plausible)) return sorted;
  return sorted.filter((o) => !isJunk(o.label));
}

interface Win { label: string | null; conf: number; margin: number; options: Option[] }
interface Slot { packed: Float32Array; t: number; m: number }

export function createStream(
  recognize: (frames: Float32Array) => Promise<RecognizeResponse>,
  onSign: (s: StreamSign) => void,
  onState: (s: SegState, rest?: RestInfo) => void,
) {
  const C = STREAM_CFG;
  let state: SegState = "idle";
  let ring: Slot[] = [];
  let prev: HolisticFrame | null = null;
  let gen = 0; // bumped on cancel: late answers are ignored
  let inflight = false;
  let flushing = false; // the hands rested: waiting for the last window before the flush
  let flushWanted = false;
  let rest: RestInfo = { since: 0, gone: false };
  let activeSince = 0, lastMove = 0, lastHand = 0, lastSent = 0, lastSentEnd = 0, noHand = 0, still = 0;
  let recent: Win[] = []; // windows since the last emission (this activity)
  let streak: { label: string; n: number; best: Win } | null = null;
  let lastEmitted: string | null = null;
  let otherLead: { label: string; n: number } | null = null;
  const stats = { sent: 0, dropped: 0, junkMotion: 0, emitted: 0 };

  const set = (s: SegState, r?: RestInfo) => { if (s !== state) { state = s; onState(s, r); } };
  const resetActivity = () => { recent = []; streak = null; lastEmitted = null; otherLead = null; flushing = false; flushWanted = false; still = 0; noHand = 0; };

  function emit(w: Win, reason: StreamSign["reason"]) {
    if (!w.label) return;
    lastEmitted = w.label;
    streak = null;
    otherLead = null;
    recent = [];
    stats.emitted++;
    onSign({ label: w.label, options: w.options, reason });
  }

  function decode(w: Win) {
    recent.push(w);
    if (recent.length > 8) recent.shift();
    if (!w.label) { streak = null; return; }
    // The last emitted label may come back only after another label has led for a while.
    if (lastEmitted && w.label !== lastEmitted) {
      otherLead = otherLead?.label === w.label ? { label: w.label, n: otherLead.n + 1 } : { label: w.label, n: 1 };
      if (otherLead.n >= C.leadChange) lastEmitted = null;
    } else otherLead = null;
    const strong = w.conf >= C.minConf && w.margin >= C.minMargin;
    if (streak?.label === w.label) {
      if (strong) { streak.n++; if (w.conf > streak.best.conf) streak.best = w; }
      // a weak window with the same leader neither counts nor breaks the streak
    } else streak = strong ? { label: w.label, n: 1, best: w } : null;
    if (streak && streak.n >= C.need && streak.label !== lastEmitted) emit(streak.best, "stable");
  }

  /** At rest: emit the label that led the last windows, if it is convincing enough. */
  function finalize() {
    const look = recent.slice(-C.flushLook).filter((w) => w.label && w.label !== lastEmitted);
    const by = new Map<string, { n: number; sum: number; best: Win }>();
    for (const w of look) {
      const e = by.get(w.label!);
      if (!e) by.set(w.label!, { n: 1, sum: w.conf, best: w });
      else { e.n++; e.sum += w.conf; if (w.conf > e.best.conf) e.best = w; }
    }
    let pick: { n: number; sum: number; best: Win } | null = null;
    for (const e of by.values()) if (!pick || e.n > pick.n || (e.n === pick.n && e.sum > pick.sum)) pick = e;
    if (pick && ((pick.n >= 2 && pick.best.conf >= C.flushConf) || (pick.best.conf >= C.flushSingleConf && pick.best.margin >= C.minMargin))) emit(pick.best, "flush");
    resetActivity();
    set("armed", rest);
  }

  /** The window ending at `end` (ms): frames with hands from max(end - winMs, activeSince - preRollMs). */
  function windowFrames(end: number): Slot[] {
    const from = Math.max(end - C.winMs, activeSince - C.preRollMs);
    const w = ring.filter((s) => s.t >= from && s.t <= end);
    return w.length > C.winMax ? w.slice(-C.winMax) : w;
  }

  function send(end: number, final: boolean) {
    const w = windowFrames(end);
    lastSent = performance.now();
    if (w.length < C.winMin) { if (final) finalize(); return; }
    // Junk filter: almost no hand motion over the window -> not a sign, don't ask.
    const mean = w.slice(1).reduce((a, s) => a + s.m, 0) / Math.max(1, w.length - 1);
    if (mean < C.minWinMotion) { stats.junkMotion++; if (final) finalize(); return; }
    lastSentEnd = w[w.length - 1]!.t;
    inflight = true;
    stats.sent++;
    const g = gen;
    recognize(packSegment(w.map((s) => s.packed)))
      .then((r) => {
        if (g !== gen) return;
        const options = dejunk(r.options);
        const top = options[0], second = options[1];
        decode({ label: top?.label ?? null, conf: top?.confidence ?? 0, margin: (top?.confidence ?? 0) - (second?.confidence ?? 0), options });
      })
      .catch(() => { if (g === gen) decode({ label: null, conf: 0, margin: 0, options: [] }); }) // the caller shows the error
      .finally(() => {
        if (g !== gen) return;
        inflight = false;
        if (final) finalize(); // the last window of this activity: flush now
        else if (flushWanted) { flushWanted = false; tail(); } // the hands rested while this one was out
      });
  }

  /** The hands rested: read the tail once more if no window covered it, then flush. */
  function tail() {
    if (inflight) { flushWanted = true; return; }
    const end = rest.gone ? lastHand : lastMove + 100;
    if (lastSentEnd < end - C.stepMs / 2) send(end, true); // finalizes when it answers (or now, if not sent)
    else finalize();
  }

  function endActivity(gone: boolean) {
    flushing = true;
    rest = { since: gone ? lastHand : lastMove, gone };
    tail();
  }

  return {
    get state() { return state; },
    get stats() { return { ...stats, inflight, ring: ring.length }; },
    arm() { gen++; inflight = false; ring = []; prev = null; resetActivity(); set("armed"); },
    cancel() { gen++; inflight = false; ring = []; prev = null; resetActivity(); set("idle"); },
    push(f: HolisticFrame, t: number) {
      if (state === "idle") return;
      const hands = handsVisible(f);
      const m = motion(prev, f);
      prev = f;
      if (hands) {
        ring.push({ packed: packFrame(f), t, m });
        if (ring.length > C.ringMax) ring.shift();
        lastHand = t;
        noHand = 0;
      } else noHand++;
      if (flushing) return; // a window is still out; its answer flushes. The ring keeps filling meanwhile.
      if (state === "armed") {
        if (!hands) { if (t - lastHand > C.goneMs) ring = []; return; }
        if (m > C.moveThresh) { set("recording"); activeSince = t; lastMove = t; lastSent = t; lastSentEnd = 0; still = 0; }
        return;
      }
      // recording
      if (m > C.moveThresh) { lastMove = t; still = 0; } else still++;
      if (noHand >= 2 && t - lastHand > C.goneMs) return endActivity(true);
      if (hands && still >= 2 && t - lastMove > C.stillMs && t - activeSince > C.minMs) return endActivity(false);
      if (!hands || t - activeSince < C.firstMs || t - lastSent < C.stepMs) return;
      if (inflight) { stats.dropped++; lastSent = t; return; } // due while one is pending: drop this window
      send(t, false);
    },
  };
}
export type SignStream = ReturnType<typeof createStream>;
