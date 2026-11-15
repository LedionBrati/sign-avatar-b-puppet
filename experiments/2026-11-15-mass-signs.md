# 2026-11-15: mass sign clips, most frequent English words first (prepared, repaint not run)

**Who:** Nikos (with Claude)
**Question:** can we push as many WLASL signs as possible through the real-time method (NEUTRAL S1 NEUTRAL S2 … batches → puppet render → one H3 Max Recast per batch → cut at the neutral midpoints), most useful words first, with a pipeline that resumes after any stop?
**Why it matters:** 34 realistic clips cover three demo sentences and a small vocabulary. Real messages need hundreds of signs. This log covers everything **up to** the paid Recast step for the top 300 words, plus cost and time for all 1,945 glosses. The owner sets a budget, and then the lead runs one command.

## Setup
- **Code:** new `pipeline/mass/mass.mjs` (Node orchestrator) and `pipeline/mass/zipf.py` (word frequency).
  - Stages: `rank`, `extract`, `batch`, `render`, `repaint`, `status`, plus `run` = all free stages.
  - Every stage skips work that's already done. State lives in `out/mass/state.json` and is written after every step, so stopping with Ctrl-C loses at most one batch.
- **Reused:**
  - `pipeline/make-batches.mjs` (cherry-picked from `nikos/vocab`): same neutral pose (`sign-avatar-b-puppet/out/realtime/neutral.clean.json`), 0.2 s blend, 24 fps, at least 3 pure neutral frames at every cut, `--max-seconds 12`.
  - `motion/batch_library.py` from `sbp-motion` (its venv and model, resumable `rows/`).
  - `puppet/render.mjs`, `pipeline/e0.mjs` (gated paid harness) and `pipeline/sign-clips.mjs cut`.
- **Machine:** i7-1355U laptop with Iris Xe graphics. It had been overheating, so the run used ≤ 3 extraction workers, one render at a time, chunked runs and nothing left in the background.

```bash
node pipeline/mass/mass.mjs rank
node pipeline/mass/mass.mjs extract --top 300 --workers 3 --chunk 90   # repeated until done
node pipeline/mass/mass.mjs batch   --top 300
node pipeline/mass/mass.mjs render  --limit 20                         # repeated; GPU by default
node pipeline/mass/mass.mjs repaint --top 300  --dry-run
node pipeline/mass/mass.mjs repaint --top 1945 --dry-run
node pipeline/mass/mass.mjs status  --top 300
```

## 1. Ranking
- **Frequency:** `wordfreq.zipf_frequency(word, "en")`, a free list that mixes spoken and written English (7 ≈ "the", 3 = rare).
  - A multiword gloss gets the **minimum** over its words, because a phrase is never more frequent than its rarest word.
  - **Caveat:** phrases still rank high. GET UP sits next to GET, and TAKE UP next to TAKE. They're cheap, so I left them in.
- **Identical videos become one sign:** WLASL reuses one SignSchool file for synonyms. AGREE and AGREEMENT are md5-identical files, and so are END, COMPLETE and OVER.
  - These are grouped. The most frequent gloss gets the clip, and the others become **aliases** in the clip manifest, pointing at the same file at no extra cost.
  - 60 glosses are aliases, 17 of them attached to kept signs in the top 300.
- **Skipped:**
  - 21 single letters (fingerspelling units, not word signs).
  - 33 signs that are already realistic: the 9 sentence clips plus the 25-sign vocab set. I is counted as a letter.
- **Result:** 1,831 ranked signs in `out/mass/ranked.json`. Rank 300 is FUN (zipf 5.30).

**Top 50:**

| | |
|---|---|
| 1–10 | TO, AND, IN, FOR, THAT, ON, WITH, THIS, ~~HAVE~~, NOT |
| 11–20 | BUT, FROM, OR, WE, ~~ALL~~, HIS, THEY, ME, IF, ONE |
| 21–30 | CAN, WILL, LIKE, ABOUT, UP, OUT, ~~WHAT~~, WHEN, MORE, WHO |
| 31–40 | THEIR, THERE, HER, WHICH, TIME, GET, GET UP, SHE, NEW, PEOPLE |
| 41–50 | SOME, ALSO, THEM, ~~FROM NOW ON~~, ~~OTHER~~ (= ANOTHER), OUR, THAN, ONLY, AFTER, FIRST |

Struck-through signs failed the hand check (see below). Zipf runs from 7.43 (TO) to 6.11 (FIRST).
- **Next up (kept):** KNOW, TWO, THINK, ANY, BACK, DON'T WANT, GO, WAY, MUCH, VERY, SHOULD, HERE, REALLY, WORK, DAY, BEFORE, TAKE, MANY, SAY, WORLD, GREAT, HOME, SAME, COME, ALWAYS, BETTER, FIND, SCHOOL, FAMILY, MONEY, FREE …
- **This is signed English, not ASL grammar:** the list starts with English function words (TO, AND, FOR, THAT). They help the translator's signed-English output. ASL drops many of them, so a later ranking could weigh ASL gloss frequency instead.

## 2. Extraction + QA (free)
- **Already there:** 31 of the top 300. 149 of them came from earlier runs; I also copied in the 43 vocab-candidate extractions from `sign-avatar-b-puppet/out/realtime/vocab/motion`, without overwriting anything.
- **Extracted now:** 269 signs in three chunks, through `index.mass.json` next to `ai-summit/data/signs/index.json` so the `videos/…` paths resolve.
  - Wall time was 7.8 min, or **1.7 s per sign** with 3 workers (59 s / 174 s / 234 s for 30 / 90 / 149 signs).
  - Most top words are short signs; the vocab run measured 8–10 s per sign per worker.
- **QA rules**, as in [demo-vocab](2026-11-15-demo-vocab.md):
  - Drop a sign if the dominant hand is detected in < 80 % of the trimmed span.
  - Drop if the clip is shorter than 8 frames.
  - Drop if it looks like **two signs in one source**: a trimmed span over 4 s, or both wrists back at rest height (< 0.25 of the hip→shoulder height) for ≥ 3 frames between two active parts. These are flagged, not fixed.
- **Result:** **242 kept, 58 dropped. All 58 failed the hand check** (32 at 70–80 %, 21 at 50–70 %, 5 under 50 %):
  > HAVE 75.9, ALL 69.1, WHAT 68.4, FROM NOW ON 77.4, OTHER 76.2, MAKE 56.4, OVER 31.2, THEN 72, BECAUSE 78.6, MOST 67.9, RIGHT 79.3, YEAR 68.6, WHY 71.8, NEVER 73, LAST 78.3, LAST YEAR 79.2, LOVE 75.9, LONG 50, UNDER 63.6, NEXT 69.6, EACH 63.9, MUST 57.1, TEAM 69.8, SECOND 70.2, NUMBER 73.3, CITY 33.3, PLAY 76.2, FEW 76.9, LET 67.2, GOD 73.2, TOP 75, CHANGE 76.1, ENOUGH 42.5, SUPPORT 53.5, POWER 58.3, SMALL 72.3, SIDE 41.7, COUNTRY 65, OPEN 67.9, WITHIN 76.7, INFORMATION 70, BECOME 71.4, CONTROL 70.8, DEATH 79.3, ALMOST 54.2, WRONG 62, REMEMBER 75, NEW YORK 59.3, NICE 72, CLOSE 68.5, INTERNATIONAL 39.6, COMMUNITY 79.4, LATE 70.8, LEAVE 79.2, LIGHT 79.3, MORNING 75.6, BUY 51.8, SOON 78.8
- **Kept signs:** mean dominant-hand detection 91.5 %, mean trimmed length 1.60 s.
- **Two-sign check:** zero hits in the top 300. On all extracted signs, the rest-dip run inside a trimmed sign was always 0 frames, so the rule is quiet on real single signs.
  - **The filename isn't the signal.** SignSchool titles like "Easter, Emergency" or "Agree, Agreement" list synonyms for **one** sign: WLASL uses the whole file (frame_start 1, frame_end −1), and EMERGENCY's file is 1.16 s of a single sign.
  - So those 17 kept signs are only flagged `multi_title_source` for the signer review, not dropped. The earlier EMERGENCY drop was over-cautious.
- **Flags for the signer review (kept):**
  - 11 signs were mirrored from left-handed signers: WHICH, AROUND, MAN, HIGH, SURE, LEFT, MEAN, CALL, COURT, CAUSE, CHECK.
  - **LEFT needs a look:** mirroring flips direction, so a left-hander's LEFT may come out pointing right.
- **The drop rate is the real limit:** 19 % here, against about 15 % in the vocab run. Several very common words fail: HAVE, ALL, WHAT, WHY, MAKE, LOVE, NICE, REMEMBER. The index has one video per gloss, so they need another WLASL instance or a re-record.

## 3. Batches (free)
`make-batches.mjs` ran in rank order, in chunks of 40 signs: **43 batches, 242 signs, 10,648 frames, 443.7 s of video.**
- 2–7 signs per batch, 5.08–11.88 s each. All are single shots between 5 and 14 s.
- At least 3 pure neutral frames at every cut.
- Only the last batch (rank 299–300, 2 signs) is padded, by 1.5 s.

| Batches | Count | Signs | Ranks | Frames | Video s | Per batch (s) | Reserve |
|---|---|---|---|---|---|---|---|
| mass-001-* | 7 | 40 | 1–43 | 1745 | 72.7 | 8.96–11.46 | $36.38 |
| mass-002-* | 7 | 40 | 46–98 | 1836 | 76.5 | 9.96–11.88 | $38.28 |
| mass-003-* | 7 | 40 | 99–147 | 1767 | 73.6 | 8.04–11.38 | $36.85 |
| mass-004-* | 7 | 40 | 150–197 | 1741 | 72.5 | 8.42–11.21 | $36.31 |
| mass-005-* | 7 | 40 | 200–245 | 1771 | 73.8 | 7.54–11.88 | $36.93 |
| mass-006-* | 7 | 40 | 246–298 | 1666 | 69.4 | 9.04–10.58 | $34.76 |
| mass-007-1 | 1 | 2 | 299–300 | 122 | 5.1 | 5.08 | $2.55 |
| **Total** | **43** | **242** | | **10648** | **443.7** | | **$222.06** |

## 4. GPU puppet render (free)
- **New flag:** `puppet/render.mjs --gpu` launches headless Chrome with `--enable-gpu --use-angle=d3d11 --ignore-gpu-blocklist`.
  - Every render now prints the WebGL `UNMASKED_RENDERER` string. With `--gpu` it fails if Chrome fell back to SwiftShader.
  - **It's real hardware:** `ANGLE (Intel, Intel(R) Iris(R) Xe Graphics … Direct3D11 …)`, against `SwiftShader Device (Subzero)` without the flag.
- **Same batch, before and after** (vocab-1, 242 frames):
  - Software: **0.240 s/frame** (58.0 s).
  - GPU: **0.035 s/frame** (8.5 s), **6.9× faster**.
  - Frame count is identical (242 = 242). PSNR between the two renders is 42.5 dB; side by side they look the same.
  - Software time was nearly all capture (233 ms/frame); the GPU removes the software readback.
- **All 43 mass batches,** run back to back:
  - 0.033–0.113 s/frame, median 0.061, mean 0.063: **3.8× faster than software** on average.
  - 882 s of wall time in total, about 20 s per batch including Chrome and vite start-up.
  - Every batch rendered frames == motion frames.
  - The speed swung with heat and background load (fastest when cool). It's still far from the software 0.24.
- **Spot check** (mass-001-1, TO AND IN FOR THAT ON WITH): every sign and the neutral cut frames render correctly.

## 5. Repaint: built, dry-run only (PAID, NOT run)
- **What `repaint --execute` does for each rendered batch:**
  1. Calls exactly `node pipeline/e0.mjs --puppet B-vrm.mp4 --source B-vrm.mp4 --model recast --resolution 768P --run-dir experiments/e0/runs/mass/B --execute --authorize-paid E0-PAID --max-usd ceil(reserve)`, with `FAL_KEY` from the environment only.
  2. Checks that generated frames == motion frames, and refuses to cut otherwise.
  3. Runs `sign-clips.mjs cut` into **`out/realtime/clips-mass/`**, with its own `manifest.json`.
  4. Adds rank, zipf and flags to each manifest entry, plus alias entries that point at the same file.
- **Budget:** `--budget-usd X` caps the **total recorded in `state.json` across all runs**, so re-running never resets it. It's checked before each call, and the reserve is written to state **before** the money is spent.
  - Default `--budget-basis reserve`: both the harness reserve sum ($0.50/s, min 5 s) and the listed-price sum ($0.085/s, min 5 s) must fit.
  - `--budget-basis listed`: only the listed-price estimate must fit. The reserve is still reported, and the harness still enforces each call's own `--max-usd ≥ reserve`.
- **Concurrency:** `--concurrency K`, default 2 (fal's limit for new accounts).
- **Safety stops:**
  - Done batches are skipped.
  - A failed or interrupted batch (`running` after a crash) is never retried automatically, because a paid request may already have gone out. Use `--retry-failed` to retry.
  - Two failures in a row stop the run.
- **Free checks:**
  - **The guards hold:** `--execute` without `--budget-usd` refuses, and so does `--execute` without `FAL_KEY`.
  - **The reserve matches the harness:** `e0.mjs --dry-run` on mass-001-1 gives exactly $5.73.
  - **`--simulate --clips-dir <scratch>` (free; the puppet mp4 stands in for generated.mp4) works end to end:** 12 batches → 69 clips with frame checks and manifest. The HOST alias pointed at `TAKE_UP.mp4`.
    - `app/server/lib/clips.mjs` loaded the existing set (34 signs) plus the simulated set (69) with no warnings.
    - `say WE WITH THAT HOST` joined in 164 ms.
    - `say … HAVE` correctly returned `unsupported`, because HAVE was dropped.

**Dry-run results:**

| Scope | Batches | Signs | Video s | Reserve (harness) | Listed price ($0.085/s) | Wall time @ concurrency 2 |
|---|---|---|---|---|---|---|
| Top 300 (built, rendered) | 43 | 242 | 443.7 | $222.06 | $37.71 | 1.1 h |
| All 1,831 ranked: built part | 43 | 242 | 443.7 | $222.06 | $37.71 | 1.1 h |
| All 1,831 ranked: projected part | 220 | ~1,235 | 2,269.9 | $1,135.20 | $192.94 | 5.3 h |
| **All (`--top 1945`)** | **263** | **~1,477** | **2,713.6** | **$1,357.26** | **$230.66** | **6.4 h** |

- **Projection:**
  - 1,531 signs aren't extracted yet. At the measured 81 % keep rate that's about 296 more drops.
  - Measured averages: 1.83 s of video per sign, 10.32 s per batch.
- **Time model:** 15 s of fal time per video second (measured 10.8–15.6) + 20 s per call, scheduled greedily over 2 slots. At the faster measured rate, top 300 is about 50 min.
- **Per sign:** about $0.16 listed or $0.92 reserve. That's in line with the earlier estimate of "about $0.20 per sign, about $350 for all 1,945", minus the drops.
- **Getting the rest ready (free):** extract, batch and render for all ~1,530 remaining signs would take about 45–60 min of extraction and about 1.2 h of rendering (about 220 batches × 20 s) on this laptop. Run it in chunks, `run --top 1945`, with the same thermal limits.

## The paid command (for the lead, after the owner sets the budget)
Run it from this worktree. `FAL_KEY` must already be in the operator's environment; never put it in a file or on the command line history.
```bash
cd C:/Users/DELL/Desktop/sbp-mass
node pipeline/mass/mass.mjs repaint --top 300 --dry-run --budget-usd 40 --budget-basis listed   # free: shows what fits
node pipeline/mass/mass.mjs repaint --top 300 --execute --budget-usd 40 --budget-basis listed --concurrency 2 \
  --clips-dir C:/Users/DELL/Desktop/sign-avatar-b-puppet/out/realtime/clips-mass
node pipeline/mass/mass.mjs status --top 300
```
- **Budget levels:**
  - `--budget-usd 40 --budget-basis listed` covers all 43 batches at the listed price ($37.71).
  - With the conservative default basis (reserve), the same 43 batches need `--budget-usd 223`.
  - A smaller budget simply stops earlier, in rank order (most frequent words first). For example, $20 listed covers 22 batches, about 125 signs.
- **Serving the new clips:** `--clips-dir` puts the clips next to the existing set in the main checkout, so the API there serves both with `CLIPS_DIR=out/realtime/clips,out/realtime/clips-mass node app/server/index.mjs`. The existing set wins on overlap. This is documented in `app/README.md` and `app/server/README.md`. Without `--clips-dir`, the clips land in this worktree's `out/realtime/clips-mass`.

## What I learned
- **Frequency order works:** the top 300 English words are mostly short WLASL signs. Extraction ran at 1.7 s per sign, and a 300-word batch set took about 25 min of laptop time end to end (extract, batch, render).
- **The binding constraint is source quality, not compute:** 19 % of the most common words fail hand detection, including HAVE, WHAT, ALL and WHY.
- **The GPU makes the puppet render a non-issue:** about 15 min for 43 batches, against about 45 min in software. Fal time (about 1 h at concurrency 2) is now the only slow step.
- **Synonym files are a free win:** 60 glosses alias an identical video, so they become extra manifest entries at no repaint cost.

## What I'd try next
- Another WLASL instance (WLASL_v0.3.json has several per gloss) for the 58 dropped signs, starting with HAVE, ALL, WHAT, WHY, MAKE, LOVE, NICE, REMEMBER. That needs a fetch step plus re-extraction.
- Rank by ASL gloss frequency (or by the translator's actual output on real text) instead of English zipf, so function words ASL drops don't take budget.
- A signer review pass over the repainted clips, starting with the 11 mirrored signs (LEFT first) and the 17 multi-title sources.
