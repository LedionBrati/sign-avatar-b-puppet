// DEV / EVAL ONLY: a clip set where every vocab sign and A-Z letter "has a clip", so the safety gate can judge
// plan quality against the 1,945-sign dictionary before those clips exist. Entries have no file and url "";
// a server in this mode must never be used for playback (index.mjs labels every response eval: "virtual_clips").

export function virtualClips(vocab) {
  const signs = new Map();
  for (const v of vocab) if (v?.motion_id && !signs.has(v.motion_id)) signs.set(v.motion_id, { motion_id: v.motion_id, gloss: v.gloss, url: "", duration_s: 0, virtual: true });
  const letters = new Map([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((l) => [l, { motion_id: `FS_${l}`, gloss: l, url: "", duration_s: 0, virtual: true }]));
  return { signs, letters, files: new Map(), dirs: [{ dir: "(virtual eval clips)", signs: signs.size }], warnings: [] };
}
