# Experiments

Every time you try something, write it down here. Even (especially) when it fails.
This is how three people working on different things stay in sync without meetings.

## How

1. Copy `_template.md` to `YYYY-MM-DD-short-name.md` (for example `2026-11-20-rest-pose-trim.md`).
2. Fill it in as you go.
3. Put big outputs (videos) in `out/` (ignored by git). Commit only small, useful results to `assets/` or link the fal URL.
4. Mention the experiment in the GitHub issue it relates to, if any.

## Index

| Date | Experiment | Who | Result in one line |
|---|---|---|---|
| 2026-11-14 | [First realistic avatar (Recast vs Reference)](../docs/findings-2026-11-14.md) | Ledi | Recast copies signs frame for frame; Reference drifts |
| 2026-11-15 | [English -> sign plan, no LLM](2026-11-15-translate-no-llm.md) | Nikos (with Claude) | Local rules + MiniLM (0.70) translate in ~0.2 ms / ~15 ms warm; speak.mjs text -> mp4 in ~90 ms; signed English, not ASL grammar |
| 2026-11-15 | [LLM agent layer (OpenAI) behind the safety gate](2026-11-15-agent-layer.md) | Nikos (with Claude) | gpt-5.4-mini plans by meaning in p50 1.35 s / p95 1.73 s, ~$0.001/sentence; with 9 clips turns 4 of 21 caption-only sentences into needs-confirmation paraphrases; 6 invented IDs caught by validation; never beats local with the 1,945-sign dictionary |
| 2026-11-15 | [Lucy realtime live repaint](2026-11-15-lucy-realtime.md) | Nikos (with Claude) | Live 720x1280 avatar ~0.5-0.6 s behind the puppet, first frame ~4.5 s, 14-21 fps, ~$2.56 spent; handshapes unreliable, invents hands from the reference pose: not usable for signing as-is |
| 2026-11-15 | [Generate-on-use: missing signs rendered in the background](2026-11-15-on-demand.md) | Nikos (with Claude) | Server queues signs with motion but no clip, renders + Recasts them in one batch and hot-reloads: HAPPY + FOOD available 127 s after first use (render 37 s, fal 84 s), $1.27 reserve; first use captions-only, later uses instant |
| 2026-11-15 | [Mass sign clips, most frequent words first](2026-11-15-mass-signs.md) | Nikos (with Claude) | Top 300 words: 242 signs pass QA, 43 batches rendered (GPU 3.8-6.9x faster); repaint dry-run $37.71 listed / $222 reserve, 1.1 h; all 1,831: ~$231 listed, 6.4 h. Paid step not run |
