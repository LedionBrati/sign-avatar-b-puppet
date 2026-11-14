# Shared plan → catalog → motion boundary

The plan contract uses only Node.js built-ins. `README.md` §6.5 is the plan source of truth, `catalog/signs.json` is the catalog source of truth, and Nikos's published `motion/FORMAT.md` is the motion v1 source of truth. The validator checks that format; it does not render an avatar or establish ASL correctness.

## Contract

`assertPlan(plan)` checks an ordered `items` array containing `sign` or `fingerspell` items. Sign `motion_id` values use uppercase IDs with digits and underscores (for example `THANK_YOU` or `RIGHT_DIRECTION`). A plan's `gloss` must exactly match the catalog entry for its ID. `nonmanual_markers` have zero-based, inclusive item spans (`from`, `to`). `unsupported_tokens` are explicit blockers.

`assertCatalog(catalog)` checks unique canonical IDs, status (`verified`, `experimental`, `unsupported`), and optional `sense`, `recognizer_label`, `source_url`, and `signer`. A `verified` entry must have a project-relative `motion_path`, `source`, and `license`. A fingerspelling mapping `A: "FS_A"` also requires `FS_A` to declare `letter: "A"`, so an unrelated sign cannot be silently reused as a letter. These are *manifest attestations*, not a file-existence check or a Deaf signer review. Only a catalog curator should mark entries verified after checking provenance, rights, and motion quality. The catalog is deliberately empty today.

`preparePlayback(plan, catalog)` returns exactly one of:

```js
{ status: "ready", input_text, caption, items, nonmanual_markers }
{ status: "unsupported", input_text, caption, blocked }
```

`ready.items` preserves signing order. Each item has `item_index`, `motion_id`, `motion_path`, and type-specific fields. Fingerspelled words expand to letter items with the same `item_index` and increasing `letter_index`. Markers retain inclusive `from`/`to` item spans and gain inclusive `from_sequence`/`to_sequence` spans after expansion. If **any** sign, letter, gloss, or English token is unsupported, no partial items are returned. Blockers include stable `code` values for the UI.

`loadPlayback(plan, catalog, loadMotion)` additionally calls `await loadMotion(path, item)` in order. It attaches each returned `motion` payload to an item. If loading fails or returns nothing, it returns `status: "unsupported"` with `motion_load_failed` and no partial items. Its public contract is unchanged. `createMotionLoader()` now provides a Node file loader for v1 JSON. `assertMotionV1()` can validate the same payload in a browser without Node imports. Neither loader nor validator animates it.

`lookupRecognizerLabel(label, catalog)` returns `matched` with one canonical sign, `ambiguous` with all candidate senses, or `unknown`. Labels are exact model output strings; the reverse route must ask for confirmation when a label has multiple senses. A matched label is not proof that recognition is correct.

## Nikos: motion and recognition

1. Export a representative `<name>.clean.json` file following `motion/FORMAT.md`, and publish the VRM player's loading entry point. Keep the matching `.raw.json` for provenance and cleanup work. The shared loader admits only cleaned files for catalog playback.
2. Register a sign in `catalog/signs.json` only after rights/provenance and QA checks. `id` is the shared key. Put the motion asset's repository-relative path in `motion_path`; use `sense` for ambiguous glosses and `recognizer_label` for recognition labels that differ from glosses.
3. Consume each `ready.items[n].motion` as the validated v1 JSON object. The player uses ordered items and marker sequence spans, preserving `null` for missing parts or individual landmarks. `pose` and hands are image coordinates; `poseWorld` and optional hand world arrays have distinct origins as described in `motion/FORMAT.md`. The validator does not retarget, interpolate, or assert facial marker support.

## Ledi: application

1. Get an ASL plan from a checked hard-coded example or planner. Validate it with `assertPlan`; do not derive independent gloss rules in the UI.
2. Call `preparePlayback` for a cheap status check or `loadPlayback` with `createMotionLoader({ root: repositoryRoot })` in Node. The catalog's `motion_path` is repository-relative. On `unsupported`, show `blocked` and the English caption; do not play a partial sentence. On `ready`, pass ordered items, their `motion` objects, and marker spans to Nikos's player. For a browser fetch path, fetch the approved asset through your application and call `assertMotionV1(json, { expectedMotionId: item.motion_id, requireClean: true })` before playback. Do not use a client-provided path as a server file path.
3. The reverse recognition route should map model labels to canonical IDs through catalog `recognizer_label` and ask the user to confirm English output. Do not equate a recognition label with a motion ID by string similarity.

## Executable fixture

Run `node examples/synthetic-integration.mjs`. The in-memory catalog, plan and returned motion objects are **synthetic wiring fixtures**, not ASL signs or Nikos-format frames. The example shows a ready handoff and a blocked handoff without any paid API or external asset.

Run `node --test shared/contracts.test.mjs` and `node shared/check-plan.mjs examples/sample-plan.json`. The latter intentionally exits 1 because the real catalog has no verified motions.

## Motion v1 loading and validation

```js
import { loadPlayback } from "./shared/contracts.mjs";
import { createMotionLoader, auditVerifiedCatalog } from "./shared/motion-loader.node.mjs";

const loader = createMotionLoader({ root: repositoryRoot });
const audit = await auditVerifiedCatalog(catalog, { root: repositoryRoot });
if (!audit.valid) throw new Error(JSON.stringify(audit.failures));
const result = await loadPlayback(plan, catalog, loader);
// result.status === "ready": result.items have v1 `motion` payloads.
// result.status === "unsupported": show `blocked`; play nothing.
```

`assertMotionV1(motion, options)` in `shared/motion-format.mjs` validates raw or cleaned v1 objects and returns the original object without changing coordinates, confidence values, or `null` landmarks. Options are `expectedMotionId`, `requireClean`, and `fileStem`. Errors are `MotionValidationError` with an `issues` array. The Node loader checks project-relative paths, symlinks, `.clean.json`, file stem, catalog ID, and planned gloss. `auditVerifiedCatalog()` checks every verified entry against its file. A sentence/reference clip with `motion_id: null` can be valid research data but can never satisfy a verified isolated sign entry.

Run `node --test shared/*.test.mjs`. Motion test fixtures under `shared/fixtures/` are synthetic and **not ASL**. No real `.clean.json` file is checked into `main` yet, so a representative file from Nikos is still needed for an integration test against his extractor output.

## First real playback check

After Nikos publishes a rights-checked isolated sign and its `.clean.json` file, register its canonical `motion_id`, exact gloss, provenance, license, and repository-relative `motion_path` in a reviewed catalog. Save a one-item plan for that ID. From the repository root run:

```sh
node shared/check-playback.mjs path/to/one-sign-plan.json path/to/catalog.json
```

The CLI calls the existing `loadPlayback()` with `createMotionLoader()`. Exit 0 means all requested motions loaded and validated; exit 1 means an unsupported plan or failed motion load, with no playable prefix; exit 2 means malformed input or invocation. The JSON report lists identity, source, FPS, frame count, sampled duration, dominant hand, mirror flag, and detected pose/face/hand frame counts. These counts expose gaps but cannot prove that left/right labels or the sign itself are correct. Compare the source video, hand labels, palm/wrist movement, and the VRM rendering visually with Nikos and a fluent signer. The CLI does not render motion.

When the player entry point is published, pass `ready.items[n].motion` from the same `loadPlayback()` call to it in order. Ledi's app should submit its plan through that call and render nothing on `unsupported`. This check can be repeated with a short sequence only after one genuine isolated sign plays correctly.
