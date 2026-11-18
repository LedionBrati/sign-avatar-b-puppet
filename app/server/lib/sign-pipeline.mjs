// Text -> signing playlist: the live clip library, the local translator (rules + the semantic model warming in the
// background), the optional agent, one playlist builder + safety gate for all of them, and generate-on-use requests
// for signs that have motion but no clip yet.

import { translate, translateRules } from "../../../translate/index.mjs";
import { loadEnglishWords, loadVocab } from "../../../translate/node.mjs";
import { loadClipSets } from "./clips.mjs";
import { virtualClips } from "./eval-vocab.mjs";
import { HttpError } from "./http.mjs";
import { assessSigning } from "./semantic-safety.mjs";
import { planToPlaylist } from "./sign.mjs";

export const MAX_TEXT = 500;
const AGENT_MODES = ["auto", "always", "off"];
const RANK = { caption_only: 0, needs_confirmation: 1, fully_supported: 2 };
const ms = (x) => Math.round(x * 100) / 100;
const vocabOf = (set) => [...set.signs.values()].map(({ motion_id, gloss }) => ({ motion_id, gloss }));

/**
 * The clip set the playlist builder and the safety gate check against, the planning vocab, and the same for clients
 * that can play the 3D signer (clips + signs that only have motion). reload() re-reads the clip dirs (on-demand
 * generation adds clips), so new signs work without a restart.
 * @param {{clipsDirs: string[], evalVocab?: string, motions: object|null, log: (line: string) => void}} o
 */
export function createClipLibrary({ clipsDirs, evalVocab, motions, log }) {
  const lib = { clips: null, planClips: null, vocab: null, motionSet: null, motionVocab: null, version: 0 };
  const load = () => {
    lib.clips = loadClipSets(clipsDirs);
    // EVAL_VOCAB: plan against the dictionary with virtual clips (never playable).
    lib.planClips = evalVocab ? virtualClips(loadVocab(evalVocab)) : lib.clips;
    lib.vocab = vocabOf(lib.planClips);
    if (motions?.size) {
      lib.motionSet = withMotion(lib.planClips, motions);
      lib.motionVocab = vocabOf(lib.motionSet);
    }
    lib.version++;
  };
  load();
  lib.clips.warnings.forEach((w) => log(`warning: ${w}`));
  if (evalVocab) log(`EVAL MODE: planning against ${lib.planClips.signs.size} "${evalVocab}" signs with VIRTUAL clips; not for playback`);
  lib.reload = (ids = []) => {
    const before = lib.clips.signs.size;
    load();
    log(`clips reloaded: ${before} -> ${lib.clips.signs.size} signs${ids.length ? ` (+${ids.join(" ")})` : ""}`);
  };
  return lib;
}

/** ~275k English words for name detection, or null (names then only by capitalization). */
export function englishWordsOrNull(log) {
  try { return loadEnglishWords(); } catch (error) { log(`warning: English word list unavailable (${error.message}); names only by capitalization`); return null; }
}

/** Clip set + motion library -> the set a 3D-capable client can sign: every clip sign (with motion_url when it also has
 *  motion) plus every sign that only has motion (url ""). Same shape as loadClipSets(), so the playlist builder and the
 *  safety gate need no special case. Letters likewise (fingerspelling plays on the 3D signer when every letter has motion). */
export function withMotion(clipSet, motions) {
  const merge = (fromClips, fromMotion) => {
    const out = new Map();
    for (const [k, c] of fromClips) {
      const m = fromMotion.get(k);
      out.set(k, m ? { ...c, motion_url: m.url } : c);
    }
    for (const [k, m] of fromMotion) {
      if (out.has(k)) continue;
      out.set(k, { motion_id: m.motion_id, gloss: m.gloss, url: "", motion_url: m.url, get duration_s() { return m.duration_s; } });
    }
    return out;
  };
  return { ...clipSet, signs: merge(clipSet.signs, motions.signs), letters: merge(clipSet.letters, motions.letters) };
}

/** Agent result beats local only if the gate rates it strictly better; ties go to the local translator. */
export function better(a, b) {
  const ra = RANK[a.safety.status], rb = RANK[b.safety.status];
  if (ra !== rb) return ra > rb;
  // Both waiting for confirmation: fewer open questions (fewer non-literal signs) is better.
  return ra === RANK.needs_confirmation && a.safety.reasons.length < b.safety.reasons.length;
}

/** Relaxed mode: the agent wins if the gate rates it better, or equal but it signs more of the message. */
function signsMore(a, b) {
  const ra = RANK[a.safety.status], rb = RANK[b.safety.status];
  if (ra !== rb) return ra > rb;
  return a.out.playlist.length > b.out.playlist.length;
}

/** "HURT WHERE~" style one-liner of a plan (~ = semantic / paraphrased sign) for the agent trace. */
const summarize = (plan) => plan.items.map((i) => (i.type === "sign" ? i.motion_id : `fs:${i.word}`) + (i.match?.method === "semantic" ? "~" : "")).join(" ");

/**
 * @param {object} o
 * @param {ReturnType<typeof createClipLibrary>} o.lib
 * @param {object|null} o.motions      the 3D signer's motion library
 * @param {object} o.ondemand          lib/ondemand.mjs createOnDemand (disabled stub when off)
 * @param {object|null} o.agent        {plan(text, vocab, opts)} or null
 * @param {object|null} o.matcher      SemanticMatcher, null = rules only
 * @param {Set<string>|null} o.englishWords
 * @param {boolean} o.relaxed          SIGNING_MODE=relaxed
 * @param {string} [o.evalVocab]
 * @param {(s: string) => string} o.redact
 * @param {(line: string) => void} o.log
 * @returns {{sign: (body: object) => Promise<object>, state: object, ready: Promise<boolean>, motionReady: Promise<boolean>}}
 */
export function createSignPipeline({ lib, motions, ondemand, agent, matcher, englishWords, relaxed, evalVocab, redact, log }) {
  const words = englishWords ?? undefined;
  const state = { semantic: matcher ? "loading" : "off", warm_ms: null, agent: agent ? "ready" : "off", semantic_motion: "off" };

  const ready = !matcher ? Promise.resolve(false) : (async () => {
    const t0 = performance.now();
    try {
      // Loads the model and embeds the vocab once ("exhausted" is a leftover word, so the semantic layer runs).
      const plan = await translate("exhausted", lib.vocab, { matcher, englishWords: words });
      const ok = Boolean(matcher.extractor) && plan.translator.semantic !== false;
      state.semantic = ok ? "ready" : "off";
      state.warm_ms = Math.round(performance.now() - t0);
      log(ok ? `semantic model ready (${state.warm_ms} ms)` : `semantic model unavailable (${matcher.failed ?? "unknown"}); rules only`);
      return ok;
    } catch (error) {
      state.semantic = "off";
      log(`semantic model failed (${error.message}); rules only`);
      return false;
    }
  })();
  // The 3D vocab (~1,800 more glosses) is embedded once in the background, after the clip vocab (disk-cached by translate/).
  const motionReady = ready.then(async (ok) => {
    if (!ok || !lib.motionVocab) return false;
    state.semantic_motion = "loading";
    const t0 = performance.now();
    try {
      await translate("exhausted", lib.motionVocab, { matcher, englishWords: words });
      state.semantic_motion = "ready";
      log(`semantic model ready for the 3d vocab (${Math.round(performance.now() - t0)} ms)`);
      return true;
    } catch (error) {
      state.semantic_motion = "off";
      log(`semantic 3d vocab failed (${error.message}); rules only for 3d-only signs`);
      return false;
    }
  });

  // Clip vocab + signs that only have motion: used (rules only) to find the words on-demand generation could cover.
  let extVocab = null, extKey = "";
  const extendedVocab = () => {
    const key = `${lib.version}/${ondemand.version}`;
    if (!extVocab || extKey !== key) {
      extKey = key;
      extVocab = [...lib.vocab, ...ondemand.motionVocab().filter((m) => !lib.planClips.signs.has(m.motion_id))];
    }
    return extVocab;
  };
  /** 3D mode: the phrase plays on the 3D signer now; signs it had no clip for are made photoreal for next time. */
  function generateFor3d(playlist) {
    if (!ondemand.enabled) return [];
    try {
      ondemand.rescan();
      return ondemand.request(playlist.filter((p) => !p.url && ondemand.has(p.motion_id)).map((p) => ({ motion_id: p.motion_id })));
    } catch (error) {
      log(`ondemand: request failed: ${error.message}`);
      return [];
    }
  }
  /** Signs the sentence needs that have motion but no clip yet: queue them; the response says which are generating. */
  function generateMissing(text, chosen, trace, opts) {
    if (!ondemand.enabled || chosen.safety.status === "fully_supported") return [];
    try {
      ondemand.rescan();
      const covered = new Set(chosen.plan.items.filter((i) => i.type === "sign" && i.match?.method !== "semantic").map((i) => i.source_index));
      const wanted = translateRules(text, extendedVocab(), opts).items
        .filter((i) => i.type === "sign" && !lib.clips.signs.has(i.motion_id) && ondemand.has(i.motion_id) && !covered.has(i.source_index));
      for (const r of trace?.rejected ?? []) if (r.reason === "not_in_vocab" && ondemand.has(r.id)) wanted.push({ motion_id: r.id });
      return ondemand.request(wanted);
    } catch (error) {
      log(`ondemand: request failed: ${error.message}`);
      return [];
    }
  }

  /** One playlist builder + safety gate for every translator: a blocked plan never returns a playable prefix
   *  (strict mode). SIGNING_MODE=relaxed keeps whatever valid signs a plan has: partial sentences sign what they can
   *  and agent paraphrases play without confirmation. A malformed plan stays blocked in both modes. */
  function finish(text, plan, set = lib.planClips) {
    const out = planToPlaylist(plan, set);
    const safety = assessSigning(text, plan, set);
    const invalid = safety.reasons?.some((r) => r.code === "invalid_plan");
    if (safety.status !== "fully_supported" && !(relaxed && !invalid && out.playlist.length)) {
      out.playlist = [];
      out.markers = [];
    }
    return { out, safety, plan };
  }

  async function sign(body) {
    const t0 = performance.now();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "bad_request", "body must be a JSON object {text, semantic?, agent?}");
    const { text, semantic = true, agent: mode = "auto", motion = false } = body;
    if (typeof text !== "string") throw new HttpError(400, "bad_text", "text must be a string");
    if (!text.trim()) throw new HttpError(400, "empty_text", "text is empty");
    if (text.length > MAX_TEXT) throw new HttpError(413, "text_too_long", `text is ${text.length} characters; the limit is ${MAX_TEXT}`);
    if (typeof semantic !== "boolean") throw new HttpError(400, "bad_semantic", "semantic must be a boolean");
    if (!AGENT_MODES.includes(mode)) throw new HttpError(400, "bad_agent", `agent must be one of ${AGENT_MODES.join(", ")}`);
    if (typeof motion !== "boolean") throw new HttpError(400, "bad_motion", "motion must be a boolean");
    const opts = { englishWords: words };
    const { planClips, vocab } = lib;
    // motion: the client plays the 3D signer, so signs with motion but no clip are signable (same safety gate).
    const set = motion && lib.motionSet ? lib.motionSet : planClips;
    const planVocab = set === planClips ? vocab : lib.motionVocab;
    const semReady = semantic && state.semantic === "ready";
    const t1 = performance.now();
    const plan = semReady && (set === planClips || state.semantic_motion === "ready")
      ? await translate(text, planVocab, { ...opts, matcher })
      : translateRules(text, planVocab, opts);
    let local = finish(text, plan, set);
    if (set !== planClips && semReady && state.semantic_motion !== "ready" && local.safety.status !== "fully_supported") {
      // The 3D vocab is still being embedded: the clip vocab's semantic plan may still sign it.
      const alt = finish(text, await translate(text, vocab, { ...opts, matcher }), set);
      if (better(alt, local)) local = alt;
    }
    const translate_ms = ms(performance.now() - t1);

    // Hybrid: the local translator answers instantly; the agent is asked only when that is not fully supported
    // (or agent: "always"). Its plan goes through the same gate and wins only if the gate rates it better.
    let chosen = local, translator = "local", trace, agent_ms;
    const warnings = [];
    if (agent && mode !== "off" && (mode === "always" || local.safety.status !== "fully_supported")) {
      const t2 = performance.now();
      let r;
      try { r = await agent.plan(text, vocab, opts); } catch (error) { r = { ok: false, code: "internal", error: redact(error) }; }
      agent_ms = ms(performance.now() - t2);
      if (r.ok) {
        const proposed = finish(text, r.plan, set);
        const wins = mode === "always" || (relaxed ? signsMore(proposed, local) : better(proposed, local));
        trace = { used: wins, status: proposed.safety.status, local_status: local.safety.status, paraphrase: r.paraphrase, notes: r.notes,
          model: r.model, cached: Boolean(r.cached), latency_ms: r.latency_ms, usage: r.usage ?? null, rejected: r.rejected ?? [] };
        if (wins) trace.local_plan = summarize(local.plan); else trace.plan = summarize(proposed.plan);
        if (r.rejected?.length) log(`agent: rejected ${r.rejected.length} proposed item(s): ${r.rejected.map((x) => `${x.reason}:${x.id ?? x.letters ?? "?"}`).join(", ")}`);
        if (wins) { chosen = proposed; translator = "agent"; }
      } else {
        trace = { used: false, local_status: local.safety.status, model: r.model, code: r.code, error: redact(r.error ?? ""), latency_ms: r.latency_ms };
        warnings.push(`agent unavailable (${r.code}); local translation used`);
        log(`agent failed (${r.code}): ${redact(r.error ?? "")}`);
      }
    }
    const generating = set === planClips ? generateMissing(text, chosen, trace, opts) : generateFor3d(chosen.out.playlist);
    // Relaxed: anything with signs plays. Clients only play "fully_supported", so report that, and keep the strict
    // verdict + reasons (skipped words stay in the captions via `unsupported`).
    let safety = chosen.safety;
    if (relaxed && chosen.out.playlist.length && safety.status !== "fully_supported") {
      safety = { ...safety, status: "fully_supported", strict_status: safety.status, mode: "relaxed" };
    }
    return {
      text, ...chosen.out, safety, plan: chosen.plan, translator,
      ...(set !== planClips && motions.rest ? { rest_motion_url: motions.rest } : {}),
      ...(translator === "agent" ? { paraphrase: trace.paraphrase } : {}),
      ...(trace ? { agent: trace } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(generating.length ? { generating } : {}),
      ...(evalVocab ? { eval: "virtual_clips" } : {}),
      timings: { translate_ms, ...(agent_ms !== undefined ? { agent_ms } : {}), total_ms: ms(performance.now() - t0) },
    };
  }

  return { sign, state, ready, motionReady };
}
