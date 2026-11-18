# E0 puppet → repaint harness

This prepares [Issue #1](https://github.com/LedionBrati/sign-avatar-b-puppet/issues/1) and checkpoints 1–3 of the original plan. It does **not** generate a puppet, call fal by default, or establish ASL correctness. Run it only after Nikos's source/skeleton/puppet comparison has passed its free finger-quality gate.

## Install and preflight

Node.js 20+, from the repository root:

```bash
cd pipeline
npm ci
npm run test:e0
cd ..
node pipeline/e0.mjs --puppet references/how2sign/judy.mp4 --source references/how2sign/judy.mp4 --model all
```

The last command is a **wiring test only**: it deliberately uses Judy's real-signer video in the puppet slot. The CLI flags this in the report. It does not upload files or require `FAL_KEY`. Reports are written to `experiments/e0/runs/<timestamp>/result.json` and `report.md`. The runs directory is ignored by Git because clips and local paths may be private. The CLI checks actual video width, height, frame rate, duration, counted frames, pixel aspect and display aspect with `ffprobe`.

## Nikos handoff

Export one **MP4** with the same signing segment and timing as its real-signer reference. Include head, upper body, both hands and individual fingers in a 3:4 frame where possible. Keep the video deterministic and record any known finger failures first. The harness does not inspect motion JSON or render the puppet.

```bash
node pipeline/e0.mjs \
  --puppet /path/to/nikos-puppet.mp4 \
  --source references/how2sign/judy.mp4 \
  --avatar assets/avatar/avatar-main.jpg \
  --model all
```

Check `result.json` for source–puppet duration and frame deltas. A warning means align or trim the clips before evaluating. A 3:4 frame matches the team's avatar framing; the harness reports other aspect ratios but does not alter the source.

## Candidate models and paid gate

The adapters map a local puppet video and avatar image to the published endpoint inputs. Dry-run mode lists all four candidates. Only Recast and Kling are currently executable; DreamActor and One-to-All stay dry-run only because a current cost bound has not been confirmed. Endpoint input schemas were checked on 15 Nov 2026: [Recast](https://fal.ai/models/minimax/h3-max/recast/api), [Kling](https://fal.ai/models/fal-ai/kling-video/v3/standard/motion-control/api), [DreamActor](https://fal.ai/models/fal-ai/bytedance/dreamactor/v2/api), [One-to-All](https://fal.ai/models/fal-ai/one-to-all-animation/14b/api).

Recast requires 5–30 seconds and no shot longer than 15 seconds; shot cuts need manual review. Kling's `character_orientation: "video"` allows up to 30 seconds. The pricing pages showed [Kling $0.126/s](https://fal.ai/models/fal-ai/kling-video/v3/standard/motion-control) and conflicting Recast price snapshots ([Recast page](https://fal.ai/models/minimax/h3-max/recast)); the harness reserves **$0.50/s at 768P** or **$0.65/s at 1080P** for Recast and **$0.20/s** for Kling. These are conservative estimates, **not a guaranteed fal spending cap**. Check the live price and account balance immediately before any paid run.

The harness requires all of `--execute`, `--authorize-paid E0-PAID`, one `--model`, `--max-usd` (>0 and ≤30), `--source`, a valid duration, and `FAL_KEY` before it imports the fal helper or uploads anything. **The team must explicitly authorize the spend before anyone uses that command.** Do not run multiple calls concurrently against the same budget.

After authorization, an operator could run:

```bash
FAL_KEY=... node pipeline/e0.mjs --puppet /path/to/nikos-puppet.mp4 \
  --source references/how2sign/judy.mp4 --model recast \
  --execute --authorize-paid E0-PAID --max-usd 5
```

The JSON log records endpoint, request ID, reserve, output cost estimate, elapsed seconds, output metadata and comparison path. Actual billed cost is left `null` because the existing `pipeline/lib/fal.mjs` response has no billing amount; reconcile it with fal's billing dashboard. A failed paid request may still incur a charge. No paid request was made while preparing this harness.

## Comparing outputs

For an output that already exists, no paid call is needed:

```bash
node pipeline/e0.mjs --puppet /path/to/nikos-puppet.mp4 \
  --source references/how2sign/judy.mp4 --generated /path/to/repaint.mp4 --model recast
```

The CLI writes `comparison.mp4` when all three clips exist: **left signer, middle puppet, right repaint**. It uses the shortest clip and 24 fps. Labels and source paths are also in `result.json` and `report.md`. Compare aligned frames; do not score a shifted clip as a model failure. The report includes an unchecked manual evaluation list for thumb, fingers, handshape, palm, wrist, body contact, facial grammar, timing and fluent-signer judgment. A generated clip stays `generated_unreviewed` until that review is written down.

## Ledi handoff

The app can read `result.json`. Show the puppet immediately, then present `comparison.path` or `inputs.generated.path` only when present. Display `status`, `alignment` warnings, request/runtime/cost estimates, and the `report.md` review status. Do **not** label the generated video accurate ASL on the basis of matching frame counts. Keep the original signer reference and puppet accessible for inspection. The selected video can be handed to the existing `pipeline/build-videos.sh` finishing flow after the team chooses it.

## Current result and blockers

Preflight on `references/how2sign/judy.mp4` (used as both source and puppet **only for wiring**) found **540×720, 24 fps, 142 frames, 5.917 seconds, 3:4**. Dry-run prepared all four adapters without a key or upload. The true E0 evaluation remains blocked on Nikos's first puppet MP4, the checkpoint 2 finger report, an authorized paid budget, and fluent ASL review. No model preservation claim is made.
