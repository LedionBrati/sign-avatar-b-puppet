// Translator plan -> SignResponse (app/core/src/api.ts). Pure, no I/O.

/**
 * @param {object} plan   translate()/translateRules() plan (items carry source_index)
 * @param {{signs: Map, letters: Map}} clips  from loadClipSets()
 * @returns {{words, playlist, unsupported, fingerspell, markers}}
 */
export function planToPlaylist(plan, clips) {
  const words = plan.input_text ? plan.input_text.split(" ") : [];
  const playlist = [];
  const unsupported = [...plan.unsupported_tokens];
  const fingerspell = [];
  const spans = []; // plan item index -> [first, last] playlist index, or null
  plan.items.forEach((item) => {
    const word_index = Number.isInteger(item.source_index) && item.source_index < words.length ? item.source_index : -1;
    const start = playlist.length;
    if (item.type === "sign") {
      const clip = clips.signs.get(item.motion_id);
      if (clip) playlist.push(entry(clip, item.gloss, word_index));
      else unsupported.push(item.source ?? item.gloss);           // defensive: vocab = clips, so this should not happen
    } else if (item.type === "fingerspell") {
      const letters = [...item.word].map((l) => clips.letters.get(l));
      if (letters.length && letters.every(Boolean)) letters.forEach((clip) => playlist.push(entry(clip, clip.gloss, word_index)));
      else fingerspell.push(item.word);
    }
    spans.push(playlist.length > start ? [start, playlist.length - 1] : null);
  });
  const markers = [];
  for (const m of plan.nonmanual_markers ?? []) {
    const covered = spans.slice(m.from, m.to + 1).filter(Boolean);
    if (covered.length) markers.push({ type: m.type, from: covered[0][0], to: covered[covered.length - 1][1] });
  }
  return { words, playlist, unsupported, fingerspell, markers };
}

const entry = (clip, gloss, word_index) => ({
  motion_id: clip.motion_id, gloss, url: clip.url, duration_s: clip.duration_s, word_index,
});
