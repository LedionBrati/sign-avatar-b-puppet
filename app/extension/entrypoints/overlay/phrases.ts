// Heard text -> POST /api/sign: requests start at once, are applied in order, and results that were overtaken are
// skipped (stay near real time). One style per phrase: photoreal clips when every sign has one, else the whole phrase
// on the 3D signer (choosePlayback in app/core); a phrase that can't be signed queues like the rest and isn't played.
import { choosePlayback, type SignResponse } from "@flux/core";
import { renderCaptions } from "./captions";
import { offline } from "./health";
import { blocked, clearVideo, enqueue, now } from "./player";
import { get3d } from "./signer3d";
import { render } from "./status";
import { client, s, ui } from "./state";

const clean = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 500);
let seq = 0;
let chain: Promise<void> = Promise.resolve();
/** Diagnostics for scripts/verify.mjs. */
const dbg = { phrases: [] as { text: string; status: string; glosses: string }[], sign: (t: string) => sign(t) };

export function initPhrases() {
  (globalThis as { __sl?: typeof dbg }).__sl = dbg;
}

export function sign(text: string) {
  const t = clean(text);
  if (!t) return;
  const id = ++seq;
  // motion: this card plays the instant 3D signer, so signs without a photoreal clip are signable too.
  const p = client.sign({ text: t, motion: true });
  p.catch(() => {});
  if (!now.job && !now.holdTimer) {
    now.heardText = t;
    now.pending = true;
    if (blocked(now.shown)) now.shown = null; // the old blocked caption gives way to the new phrase
    renderCaptions();
    render();
  }
  chain = chain.then(async () => {
    let res: SignResponse;
    try {
      res = await p;
    } catch (e) {
      if (id === seq) { now.pending = false; clearVideo(); offline(e); renderCaptions(); }
      return;
    }
    if (id === seq) now.pending = false;
    if (ui.isOffline) { ui.isOffline = false; render(); }
    dbg.phrases.push({ text: t, status: res.safety?.status ?? "?", glosses: res.playlist.map((x) => x.gloss).join(" ") });
    if (id < seq - 2) return; // overtaken while waiting: keep up with the speech
    const mode = choosePlayback(res, { always3d: s.always3d });
    if (mode === "none") res = { ...res, playlist: [], markers: [] };
    if (mode === "3d") get3d().prefetch(res.playlist, res.rest_motion_url);
    enqueue({ res, mode });
  });
}
