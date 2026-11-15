# Local four-sign demo vocabulary

This is a repeatable **technical** demo of `HELLO`, `THANK_YOU`, `YES`, and `NO` from isolated WLASL v0.3 SignSchool clips. It makes three short, manually ordered plans: “Hello. Thank you.”, “Yes, thank you.”, and “No, thank you.” The exact IDs, WLASL video IDs, local paths, provenance, plans, and observed status are in [`manifest.json`](manifest.json). The phrases have **not** been reviewed for ASL grammar or avatar intelligibility.

## Rights and local files

[WLASL's license](https://dxli94.github.io/WLASL/) limits the dataset to academic/computational noncommercial use. Original SignSchool and derived-motion redistribution permissions are still unresolved. Keep source MP4s, raw/clean JSON, reports, renders, and the generated catalog under git-ignored `out/demo/`; do not commit or distribute them. The source URLs in the manifest are provenance identifiers, not an instruction to republish the videos. Have a fluent/Deaf signer review the clips and avatar before any production `verified` catalog entry.

Place these four legitimately obtained videos at the exact paths below before running the script:

| Sign | WLASL video ID | Local source path | Signer |
| --- | --- | --- | --- |
| HELLO | 27172 | `out/demo/source/hello-27172.mp4` | 46 |
| THANK_YOU | 57655 | `out/demo/source/thank-you-57655.mp4` | 46 |
| YES | 64284 | `out/demo/source/yes-64284.mp4` | 3 |
| NO | 38527 | `out/demo/source/no-38527.mp4` | 3 |

## Reproduce

Use Node 20+, `uv`, and Chrome. The existing lockfiles pin dependencies. From the repository root:

```sh
cd motion && uv sync --locked && uv run python fetch_model.py && cd ..
cd puppet && npm ci && node fetch-model.mjs && cd ..
cd pipeline && npm ci && cd ..
node examples/demo-vocabulary/run-local.mjs
```

If `uv` is not on `PATH`, set `UV_BIN=/absolute/path/to/uv` for `run-local.mjs`. The script invokes Nikos's existing `extract.py`, `clean.py --trim-rest`, `report.py`, `puppet/compose.mjs` (which uses `concatClips()`), and `render.mjs`. It never downloads source media or calls a paid service. `--no-render` validates and composes without Chrome; `--force` repeats extraction, cleanup and reports. Existing raw/clean/report outputs are reused by default.

The runner validates **raw and clean** JSON with `assertMotionV1()` and Nikos's `validateMotion()`, audits an `out/demo/catalog-wiring-only.json` fixture, loads each plan through `loadPlayback()`, and writes `out/demo/run-summary.json`. That local fixture sets `status: "verified"` only because the shared playback API requires it. Its `test_only: true` flag and note explicitly deny product QA or rights approval. **Do not ship or import it as the production catalog.** Unknown items still produce the existing all-or-nothing `unsupported` result.

For a quick independent check after running the script:

```sh
node shared/check-playback.mjs examples/demo-vocabulary/plans/hello-thank-you.json out/demo/catalog-wiring-only.json .
node shared/check-playback.mjs examples/demo-vocabulary/plans/yes-thank-you.json out/demo/catalog-wiring-only.json .
node shared/check-playback.mjs examples/demo-vocabulary/plans/no-thank-you.json out/demo/catalog-wiring-only.json .
node --test shared/*.test.mjs
cd motion && uv run pytest -q
cd ../puppet && npm test && npm run typecheck
```

## What was observed locally

| Sign | Clean frames | Right hand tracked | Active detection in Nikos's report | Filled frames | Visual concern |
| --- | ---: | ---: | ---: | ---: | --- |
| HELLO | 48 | 44 | 100% | 0 | Avatar hand crosses the eye; signer contact is at the forehead/temple. |
| THANK_YOU | 36 | 34 | 93.8% | 2 | Avatar contact sits at chest rather than signer's chin. |
| YES | 40 | 36 | 97.2% | 1 | Fast fist movement is blurred in the source; avatar curl needs signer review. |
| NO | 37 | 34 | 97.0% | 1 | Two-finger/thumb closure is small; inspect the close-up before use. |

All four clips were right dominant and unmirrored. Pose and face were present in every clean frame; the left hand was not detected, consistent with these one-handed examples, but that does not prove all left-hand motion is irrelevant. Hand world point 0 matched the `poseWorld` right wrist in all tracked frames. Maximum timestamp deviation from `i/fps` was under 0.000035 s. Both validators accepted all raw and clean files without warnings. The renderer's missing right-hand counts were 4, 2, 4, and 3 frames respectively. Low direct-solver angle error confirms fit to tracked landmarks, **not** linguistic correctness.

The three plan-to-motion-to-VRM renders completed at 29.97 fps with 78, 70, and 67 frames respectively. The 0.2 s blends pass through a low, awkward hand position, especially between different signers. `THANK_YOU` contact is visibly wrong in the avatar. The English captions are source prompts, not evidence that these gloss sequences are fluent ASL. Local videos are at the `render_path` entries in the manifest; isolated source | skeleton | VRM comparisons are at each sign's `comparison_path`.

## Ledi handoff

For a **local internal preview**, use the three committed plan JSON files and the generated `out/demo/catalog-wiring-only.json`. Call `loadPlayback(plan, catalog, createMotionLoader({ root }))` in Node, then pass ordered `ready.items[n].motion` to Nikos's player; the runner stages those exact objects and calls `puppet/compose.mjs`. On `unsupported`, display the blockers and render no prefix. The runner's `out/demo/composed/*.json` and `out/demo/renders/*.mp4` are preview outputs that Ledi can show as preloaded examples after the team resolves distribution rights. For an app build or shared demo, replace the local fixture only after rights and signer QA, then use the same API. The runtime composite from `concatClips()` is not an isolated `.clean.json` catalog asset.

Nikos's separate `nikos/app-base` branch exposes a `CLIPS_DIR` MP4 playlist contract. This work does not write that clip-set manifest: those clips assume a shared neutral start/end pose, while the current isolated motions have sign-specific rest poses and show a low hand dip when blended. The three pre-rendered sequence MP4s are the appropriate local preview outputs until that transition is fixed and rights are cleared.
