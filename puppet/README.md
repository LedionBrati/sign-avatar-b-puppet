# puppet/

Motion JSON ([`motion/FORMAT.md`](../motion/FORMAT.md)) → landmark debug view + VRM puppet, in the browser and as offline mp4 renders at the avatar framing (540×720, 24 fps, waist up).

```bash
cd puppet && npm install && node fetch-model.mjs          # VRM sample model -> puppet/models/ (git-ignored)
npm run dev    # http://127.0.0.1:5181/?motion=out/motion/judy.clean.json&video=references/how2sign/judy.mp4
cd .. && node puppet/render.mjs --motion out/motion/judy.clean.json --view sidebyside --video references/how2sign/judy.mp4 --closeup --out out/puppet/judy-sidebyside.mp4
npm test && npm run typecheck                               # in puppet/
```

- **Viewer params:** `motion`, `video` (paths relative to the repo root, or absolute), `view=sidebyside|skeleton|vrm`, `closeup=1`, `solver=direct|kalidokit`, `mannequin=1`, `smooth=0` (raw puppet, see below). Keys: space play/pause, ←/→ step. Without `motion` it plays the synthetic fixture `fixtures/wave.json` (`npm run fixture` regenerates it).
- **Smooth playback (default):** every frame is solved once, then the bone rotations are cleaned over the whole clip ([`src/track.ts`](src/track.ts)): tracker glitches out (a joint that leaves its path and comes back faster than it can move, e.g. a hand read inside out for 1-3 frames; a whole hand is repaired together when its wrist glitches or 5+ of its joints glitch at once), tracking dropouts bridged (up to 0.5 s) or eased to rest and back (no snaps), and a light zero-phase smoothing (no lag, held handshapes stay exact). The viewer plays the result between frames on every screen refresh, with hair and cloth physics. The status line and `<out>.json` say how many bone-frames were repaired. `smooth=0` / `--raw` shows every frame exactly as tracked. On Judy: max one-frame arm/wrist jump 177° → 66°, frame-to-frame jerk about halved, fingers outside the glitch frames within 2.3° (median) of the landmarks.
- **render.mjs** steps `window.renderFrame(i)` in headless Chrome (software WebGL), pipes PNGs to ffmpeg (libx264, yuv420p) and checks the frame count with ffprobe. Frame i of the video is motion frame i, smoothed or `--raw`. `--view vrm` is clean (no overlays), for the repaint. It also writes `<out>.json`: tracking failures (part missing) vs retargeting errors (avatar bone vs landmark, degrees) of the rendered pose, plus `smoothing`. Chrome path: `CHROME=...`.
- **Solvers:** `direct` (default) aims every bone at the landmarks, fingers included (curl and spread, palm normal for the hand, whose roll goes to the forearm: a wrist cannot roll). `kalidokit` is the GSL-repo approach (curl only, heuristic arms), kept for comparison. Code: `src/motion.ts` (format), `src/blend.ts` (sentence blending), `src/skeleton.ts` (2D view), `src/vrm.ts` (puppet), `src/track.ts` (clean-up).
- **Model:** `VRM1_Constraint_Twist_Sample.vrm`, © 2022 pixiv Inc., [VRM Public License 1.0](https://vrm.dev/licenses/1.0/); its meta allows everyone to use, modify and redistribute it, commercial use included, credit not required. Still kept out of git; `fetch-model.mjs --all` also gets Seed-san (VirtualCast, credit required).
