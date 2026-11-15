# Shared integration status — 15 Nov 2026

## What works now

- PRs #9, #10, #11, and #12 are merged into `main`. The E0 repaint harness and shared motion loader remain separate modules.
- `assertPlan()` validates ordered signs, fingerspelling, and nonmanual spans. `preparePlayback()` resolves only catalog entries marked `verified` and returns all items or an explicit unsupported result.
- `assertMotionV1()` validates Nikos's published `motion/FORMAT.md` structure. `createMotionLoader()` reads a project-relative `.clean.json` asset, checks its ID and gloss, and plugs into the existing `loadPlayback()` callback. Missing landmarks remain `null`.
- `node --test shared/*.test.mjs`: 23 passing tests. `node examples/synthetic-integration.mjs` runs. All motion fixtures in these tests are synthetic and **not ASL**.
- The E0 harness's 4 tests pass in its existing worktree with its installed dependencies. No paid model was called during this check.

## Current end-to-end blocker

No `nikos/motion`, `nikos/puppet`, or Ledi frontend branch is published on GitHub as of this check. `main` contains `motion/FORMAT.md` but no `.clean.json`/`.raw.json` files or VRM player entry point. `catalog/signs.json` has no sign entries. `node shared/check-plan.mjs examples/sample-plan.json` exits 1 as designed: HELLO, MY, and NAME are unknown, and MARIA lacks M, A, R, and I fingerspelling motions. No real text-to-VRM playback has been observed.

## Exact inputs needed for the first real test

1. **Nikos motion:** one authentic, rights-checked isolated sign exported as a `.clean.json` file, plus its `.raw.json` partner and source/provenance details. The clean file needs `version: 1`, a canonical `motion_id`, a matching gloss, and the frame fields from `motion/FORMAT.md`. A full-sentence reference with `motion_id: null` cannot be registered as a verified isolated sign.
2. **Nikos player:** a published module or command that accepts the validated v1 motion object and renders it on the VRM avatar. We need its entry point and any coordinate/retargeting assumptions. The shared loader returns the JSON without changing coordinates or filling gaps.
3. **Catalog review:** a matching `catalog/signs.json` entry with `status: "verified"`, `motion_path` pointing to the clean file, source, and license, after provenance and motion QA. Technical validation alone does not establish ASL correctness.
4. **Ledi frontend:** the application's plan input and playback call site. It can call `loadPlayback(plan, catalog, createMotionLoader({ root }))` on the Node side, or fetch an approved asset and call browser-safe `assertMotionV1()` before passing `ready.items[n].motion` to the player. It must show `blocked` and play nothing when status is `unsupported`.

## First shared connection test

Use a one-item plan for the same genuine isolated sign, register its reviewed clean file, then run `assertMotionV1()` and `loadPlayback()` against that file. Feed the resulting `ready.items[0].motion` into Nikos's player inside Ledi's application. Observe the rendered movement against the source clip and record tracking, retargeting, and ASL review separately. Only after that works should we attempt a multi-item sentence or E0 repaint comparison.
