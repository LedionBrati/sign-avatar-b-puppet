# Shared plan → catalog → motion boundary

This module uses only Node.js built-ins. `README.md` §6.5 is the plan source of truth; `catalog/signs.json` is the catalog source of truth. Nikos's `motion/FORMAT.md` will define the motion payload when published. This layer does not define landmark frames or render an avatar.

## Contract

`assertPlan(plan)` checks an ordered `items` array containing `sign` or `fingerspell` items. Sign `motion_id` values use uppercase IDs with digits and underscores (for example `THANK_YOU` or `RIGHT_DIRECTION`). A plan's `gloss` must exactly match the catalog entry for its ID. `nonmanual_markers` have zero-based, inclusive item spans (`from`, `to`). `unsupported_tokens` are explicit blockers.

`assertCatalog(catalog)` checks unique canonical IDs, status (`verified`, `experimental`, `unsupported`), and optional `sense`, `recognizer_label`, `source_url`, and `signer`. A `verified` entry must have a project-relative `motion_path`, `source`, and `license`. A fingerspelling mapping `A: "FS_A"` also requires `FS_A` to declare `letter: "A"`, so an unrelated sign cannot be silently reused as a letter. These are *manifest attestations*, not a file-existence check or a Deaf signer review. Only a catalog curator should mark entries verified after checking provenance, rights, and motion quality. The catalog is deliberately empty today.

`preparePlayback(plan, catalog)` returns exactly one of:

```js
{ status: "ready", input_text, caption, items, nonmanual_markers }
{ status: "unsupported", input_text, caption, blocked }
```

`ready.items` preserves signing order. Each item has `item_index`, `motion_id`, `motion_path`, and type-specific fields. Fingerspelled words expand to letter items with the same `item_index` and increasing `letter_index`. Markers retain inclusive `from`/`to` item spans and gain inclusive `from_sequence`/`to_sequence` spans after expansion. If **any** sign, letter, gloss, or English token is unsupported, no partial items are returned. Blockers include stable `code` values for the UI.

`loadPlayback(plan, catalog, loadMotion)` additionally calls `await loadMotion(path, item)` in order. It attaches each returned opaque `motion` payload to an item. If loading fails or returns nothing, it returns `status: "unsupported"` with `motion_load_failed` and no partial items. The loader owns path resolution, frame validation, caching and animation. This keeps the shared contract independent of Nikos's unpublished format.

`lookupRecognizerLabel(label, catalog)` returns `matched` with one canonical sign, `ambiguous` with all candidate senses, or `unknown`. Labels are exact model output strings; the reverse route must ask for confirmation when a label has multiple senses. A matched label is not proof that recognition is correct.

## Nikos: motion and recognition

1. Publish `motion/FORMAT.md`, one representative asset and the VRM player's loading entry point. Keep raw and cleaned coordinates distinct in that format.
2. Register a sign in `catalog/signs.json` only after rights/provenance and QA checks. `id` is the shared key. Put the motion asset's repository-relative path in `motion_path`; use `sense` for ambiguous glosses and `recognizer_label` for recognition labels that differ from glosses.
3. Implement `loadMotion(path, item)` using the published format. The returned object is opaque to this module. The player consumes `ready.items` and marker sequence spans in order. Do not assume facial markers are animated until supported by the player.

## Ledi: application

1. Get an ASL plan from a checked hard-coded example or planner. Validate it with `assertPlan`; do not derive independent gloss rules in the UI.
2. Call `preparePlayback` for a cheap status check or `loadPlayback` with Nikos's loader. On `unsupported`, show `blocked` and the English caption; do not play a partial sentence. On `ready`, pass ordered items and marker spans to Nikos's player.
3. The reverse recognition route should map model labels to canonical IDs through catalog `recognizer_label` and ask the user to confirm English output. Do not equate a recognition label with a motion ID by string similarity.

## Executable fixture

Run `node examples/synthetic-integration.mjs`. The in-memory catalog, plan and returned motion objects are **synthetic wiring fixtures**, not ASL signs or Nikos-format frames. The example shows a ready handoff and a blocked handoff without any paid API or external asset.

Run `node --test shared/contracts.test.mjs` and `node shared/check-plan.mjs examples/sample-plan.json`. The latter intentionally exits 1 because the real catalog has no verified motions.
