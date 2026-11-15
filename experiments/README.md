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
| 2026-11-15 | [Lucy realtime live repaint](2026-11-15-lucy-realtime.md) | Nikos (with Claude) | Live 720x1280 avatar ~0.5-0.6 s behind the puppet, first frame ~4.5 s, 14-21 fps, ~$2.56 spent; handshapes unreliable, invents hands from the reference pose: not usable for signing as-is |
