# Shared integration status — 15 Nov 2026

## Implemented and tested

- Ordered `sign` / `fingerspell` plan validation with inclusive nonmanual item spans.
- Canonical uppercase sign IDs and one catalog with gloss, optional sense and recognizer label, QA status, provenance, and a project-relative motion reference.
- All-or-nothing plan resolution: a missing sign, unverified motion, mismatched gloss, unavailable letter, or unsupported English token yields an explicit blocked result with no playable prefix.
- Expanded sequence spans for facial markers when fingerspelled words become letter motions.
- `preparePlayback()` for Ledi's application and `loadPlayback()` for an engine-supplied motion loader. Motion data remains opaque; no duplicate extractor or VRM viewer was made.
- `lookupRecognizerLabel()` returns matched, ambiguous, or unknown instead of guessing a sense.
- 16 Node tests pass. The checked-in sample plan validates but the empty real catalog blocks all four items, as intended. The synthetic integration example runs and is explicitly not ASL motion.

## Waiting on Nikos

`nikos/motion`, `nikos/puppet`, and `motion/FORMAT.md` were not on GitHub when checked. Once pushed, inspect the actual frame format and the player entry point, then implement `loadMotion(path, item)` and a small end-to-end test using a real, rights-checked asset. Do not convert or reinterpret coordinate systems in the shared contract.

## Waiting on Ledi

Ledi's application branch was not on GitHub when checked. The app can call `preparePlayback(plan, catalog)` to show ready/unsupported status now, then `loadPlayback(plan, catalog, NikosLoader)` when the engine arrives. The UI should display blockers and caption and must not play a partial sentence.

## Real signing assets

`catalog/signs.json` remains empty. WLASL research or clips do not equal verified playable VRM motions. Register only entries whose rights, sense, provenance, motion file, and quality have been checked. No real ASL sentence is claimed playable by this PR.

## Next integration step

At the first shared connection checkpoint, take one real Nikos motion file and player load call, add its reviewed catalog entry, and run the same hard-coded plan through Ledi's app. Keep signer review separate from technical playback success.
