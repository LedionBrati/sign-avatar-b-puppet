# puppet/avatar/: the realistic reference signer

`puppet/models/signer.glb` replaces the anime VRM as the reference the video model repaints. A woman with realistic proportions, a black long-sleeve top, skin-tone hands, long dark hair, a soft-lit grey wall, framed like `assets/avatar/avatar-main.jpg`.

```bash
node puppet/avatar/build.mjs        # downloads MPFB + MakeHuman CC0 assets once (~330 MB), runs Blender headless, ~2 min
node puppet/render.mjs --motion out/motion/wlasl/hello-aaf4c6.clean.json --view vrm --avatar signer --gpu \
     --passes rgb,depth,normal,seg --out out/b/hello-signer.mp4
```

- **Made with** [MPFB 2.0.18](https://extensions.blender.org/add-ons/mpfb/) (MakeHuman for Blender) in Blender 4.5, by `build_avatar.py`. Not hand-edited, so it can be rebuilt or changed (`--hair`, body sliders in the script).
- **Rig:** MakeHuman's "mixamo" skeleton. 3 bones per finger and thumb, plus a tip bone per finger that `build_avatar.py` adds, so the player knows where each fingertip is. `src/avatar.ts` maps it onto the VRM humanoid, so every solver, the clean-up and the reports work unchanged.
- **Top:** painted on the body mesh by bone weights. Torso and arms are black fabric, hands and neck are skin, and the cuff sits at the wrist joint. The chest is smoothed, because a top hides the nipples.
- **Look:** a room environment map for soft light, a large soft key from camera-left, neutral tone mapping, no cel shading (`applyRealisticLook` in `src/vrm.ts`).

## Licence

| Part | Licence |
|---|---|
| MakeHuman base mesh, targets, skeleton, weights (bundled with MPFB) | CC0 1.0 |
| MakeHuman system assets: `young_caucasian_female` skin, brown eyes, eyebrow001, eyelashes01, `long01` hair | CC0 1.0 (the asset files say "explicitly released as CC0 in September 2020") |
| MPFB, the Blender add-on that builds it | GPL-3.0. Its output is not covered by the GPL (MakeHuman's licence FAQ) |
| `signer.glb` | So CC0. It stays out of git anyway (`puppet/models/` is ignored), like the VRM |
