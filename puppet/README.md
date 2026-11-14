# puppet/

Motion JSON ([`motion/FORMAT.md`](../motion/FORMAT.md)) → landmark debug view + VRM puppet, in the browser and as offline mp4 renders at the avatar framing (540×720, 24 fps, waist up).

```bash
cd puppet && npm install && node fetch-model.mjs          # VRM sample model -> puppet/models/ (git-ignored)
npm run dev    # http://127.0.0.1:5181/?motion=out/motion/judy.clean.json&video=references/how2sign/judy.mp4
cd .. && node puppet/render.mjs --motion out/motion/judy.clean.json --view sidebyside --video references/how2sign/judy.mp4 --closeup --out out/puppet/judy-sidebyside.mp4
npm test && npm run typecheck                               # in puppet/
```

- **Viewer params:** `motion`, `video` (paths relative to the repo root, or absolute), `view=sidebyside|skeleton|vrm`, `closeup=1`, `solver=direct|kalidokit`, `mannequin=1`. Keys: space play/pause, ←/→ step. Without `motion` it plays the synthetic fixture `fixtures/wave.json` (`npm run fixture` regenerates it).
- **render.mjs** steps `window.renderFrame(i)` in headless Chrome (software WebGL), pipes PNGs to ffmpeg (libx264, yuv420p) and checks the frame count with ffprobe. `--view vrm` is clean (no overlays), for the repaint. It also writes `<out>.json`: tracking failures (part missing) vs retargeting errors (avatar bone vs landmark, degrees). Chrome path: `CHROME=...`.
- **Solvers:** `direct` (default) aims every bone at the landmarks, fingers included (curl and spread, palm normal for wrist twist). `kalidokit` is the GSL-repo approach (curl only, heuristic arms), kept for comparison. Code: `src/motion.ts` (format), `src/blend.ts` (sentence blending), `src/skeleton.ts` (2D view), `src/vrm.ts` (puppet).
- **Model:** `VRM1_Constraint_Twist_Sample.vrm`, © 2022 pixiv Inc., [VRM Public License 1.0](https://vrm.dev/licenses/1.0/); its meta allows everyone to use, modify and redistribute it, commercial use included, credit not required. Still kept out of git; `fetch-model.mjs --all` also gets Seed-san (VirtualCast, credit required).
