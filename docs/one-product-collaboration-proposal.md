# Proposal: One ASL product, three parallel workstreams

**Status:** Proposed for team review — not an assignment or a replacement for the README  
**Date:** 14 November 2026 · **Submission target:** 15 November 2026, 18:00 Europe/Athens  
**Related:** [Nikos's product plan PR #7](https://github.com/LedionBrati/sign-avatar-b-puppet/pull/7) · [Method B checkpoints](../README.md#4-the-path-4-checkpoints) · [cross-team audit #6](https://github.com/LedionBrati/sign-avatar-b-puppet/issues/6)

## The proposal in one paragraph

Let's stop treating the team's experiments as separate products. We should build **one two-way ASL communication experience** in this repository, with three focused streams running in parallel and integrating continuously. **Nikos should continue the WLASL, ASL-planning and recognition work he's already started. Alex should own the real-signer-motion → programmable VRM proof. Ledi should lead the unified product experience and integration of our existing realistic-avatar/video pipeline.** These are proposed areas of focus, not rigid boundaries; anyone can help unblock another stream. Everything should converge on the same user-facing application and a common vocabulary/plan contract.

## Product vision: one experience, two directions

1. **Hearing → Deaf:** English text / speech → constrained ASL plan → authentic sign motion → browser 3D signer → optional realistic AI repaint, with captions.
2. **Deaf → Hearing:** Webcam signing → constrained sign/fingerspelling recognition → user-confirmed English text → speech.

Both directions should share **one sign lexicon, canonical sign IDs, provenance, and UI**. The second direction is an integrated workstream, not a reason to block the first working sign animation.

The already-verified **Recast-on-real-signer video** is a visual asset and fallback. The main technical direction remains **Method B**, as Ledi's updated README now states. We are *not* proposing a separate Method A product or reopening that decision.

## Suggested ownership (confirm in review)

| Person | Proposed lead | Concrete output to integrate | Existing work to keep |
|---|---|---|---|
| **Nikos** | ASL data + intelligence | WLASL ingestion / metadata, constrained text→plan, pretrained sign / fingerspelling recognition, diagnostic evaluation | Continue his existing `ai-summit` work and [PR #7](https://github.com/LedionBrati/sign-avatar-b-puppet/pull/7); do not restart |
| **Alex** | Motion + 3D signer | Source clip → MediaPipe extraction → raw/cleaned motion → VRM retargeting/playback; finger and palm QA; optional puppet→repaint experiment | Reuse existing GSL recorder/VRM work if access is authorized; track [#4](https://github.com/LedionBrati/sign-avatar-b-puppet/issues/4), [#2](https://github.com/LedionBrati/sign-avatar-b-puppet/issues/2), [#1](https://github.com/LedionBrati/sign-avatar-b-puppet/issues/1) |
| **Ledi** | App + integration + demo | Unified front end and API composition, UX for both directions, existing Recast/video scripts and assets, demo flow / fallback | Continue current avatar, presentation and processing pipeline |

**Agreement requested:** Are these useful starting owners? Name any overlap or work already running locally. No one is automatically assigned by this document.

## Shared contracts: agree these before parallel agents diverge

### A. Canonical sign catalog

Every supported sign has a stable `motion_id` / `sign_id` and metadata:

- `gloss` and optional **meaning/sense** (avoid ambiguities such as RIGHT / RIGHT, BANK, etc.)
- source recording, signer, exact time range, fps, dominant hand, licensing/credit
- actual availability: `verified`, `experimental`, or `unsupported`
- motion/video asset references, if they exist

**Input facts:** Nikos reports ~1,945 WLASL entries downloaded in `ai-summit`. This is promising work to reuse, **not** an already-tested 1,945-sign VRM dictionary in this repo. Check legality, availability, and representative motion quality before claiming coverage. Our four How2Sign clips are **full sentences**, not isolated-sign recordings.

### B. English → ASL plan (one agreed shape)

Use the shape already proposed in **README §6.5** as the starting contract. For example:

```json
{
  "input_text": "Hello, my name is Maria.",
  "signs": [
    { "gloss": "HELLO", "motion_id": "HELLO", "hold_ms": 0 },
    { "gloss": "MY", "motion_id": "MY" },
    { "gloss": "NAME", "motion_id": "NAME" }
  ],
  "fingerspelling": [{ "word": "MARIA", "after_sign": 2 }],
  "nonmanual_markers": [],
  "unsupported_tokens": [],
  "caption": "Hello, my name is Maria."
}
```

The planner and UI **must not invent motions**. If an ID is absent, show an explicit unsupported response. Do not substitute fingerspelling or English word order and call it verified ASL translation. A–Z motions are not yet available per PR #7; this example is a proposed interface, **not a currently runnable demo**.

### C. Motion / renderer contract

Start with the frame format from the README and Nikos's PR: `{gloss, fps, frames:[{pose, poseWorld, face, leftHand, rightHand}], meta:{source, signer, licence, start, end, dominantHand}}`. Preserve raw data alongside cleaned output, distinguish landmark coordinate systems, and give the browser playback and offline rendering **the same timeline and bone-motion code where practical**.

The React app should invoke the **plan** and render its status, not implement independent gloss rules. The sign recognizer should consume a documented landmark schema (which may need a separate input adapter); **do not assume** recognition and avatar output coordinates are trivially identical.

### D. UI and service integration

One app with two clear tabs or modes: **Text/Speech → Sign** and **Sign → Text/Speech**.

- Show **captions, supported signs, unsupported signs and source confidence** clearly.
- **Instant puppet preview** while optional AI repaint is processing, as proposed in PR #7.
- Keep repaint behind an intentional button or budget gate: reported latency and cost make automatic per-sentence generation risky.
- Prefer reusing existing `pipeline/` and `assets/` instead of rebuilding those systems.
- The Chrome extension / PWA install polish may be developed in parallel, but must never hold the core localhost demo hostage.

## How we execute together

The **README's four ordered Method B checkpoints are the source of truth for Alex's animation pipeline**:

1. **Free motion proof:** real signer | extracted skeleton | browser puppet, with provenance.
2. **Free finger quality gate:** tracking vs cleanup vs puppet; thumb, curl/spread, palm, wrist and missing frames.
3. **Budgeted repaint comparison:** Recast / other candidate(s) on puppet vs source, with explicit go/no-go and a protected real-signer-video fallback.
4. **Text-to-sign end-to-end:** one hardcoded, supported plan → motion → puppet → optional repaint, then expand.

**In parallel**, Nikos may continue his WLASL builder, plan interface and sign-recognition evidence, while Ledi builds the unified shell and assembles the reusable video assets. Only dependencies need to wait for the animation checkpoints; other tracks should keep making progress.

### Integration rhythm

- **First synchronization:** Agree owners, branch names, minimal motion schema, plan JSON, and one or two shared demo examples.
- **Continuous integration:** Small feature branches and PRs; integrate a thin stubbed plan→UI→avatar path early, then replace stubs with the real components. No long-lived isolated app forks.
- **Checkpoints:** Each contributor reports *what works / tested / blockers / next*, with runnable commands and artifact links. Call out local work not yet pushed.
- **Demo stabilization:** Agree a feature-freeze point with enough time to rehearse, record a backup, and evaluate accuracy. A half-working direction should not take down the working direction.

### Suggested repo areas, not required rewrites

- `motion/` — extraction, cleaned clips, QA
- `puppet/` — VRM renderer, transitions, offline render
- `recognize/` — constrained webcam sign/fingerspelling recognition
- `app/` — unified interface / API
- `pipeline/` — existing processing scripts, retained
- `experiments/` — reproducible experiments and go/no-go notes

Please adapt to existing code rather than enforcing these paths blindly.

## What we will show at the pitch

**The ambition:** One product demonstrating **two-way communication**. A hearing participant speaks/types and sees the ASL signer; a Deaf participant signs and sees confirmed English text / hears synthesized speech.

**The evidence standard:** Label each component as *working live*, *working on supported prerecorded clips*, or *experimental*. Nikos's reported recognition scores on clean clips are not verified live-webcam accuracy; a convincing VRM animation is not proof of ASL grammatical correctness. Any language-accuracy claim should be reviewed by a fluent ASL signer.

If realistic repaint damages hands, keep the faithful programmable puppet and the already-working Recast-on-real-signer fallback. No fabricated signs. Noncommercial dataset terms and video-derived rights must be respected for the actual pitch/distribution.

## Decisions requested from Ledi and Nikos

1. **One product / one integration repository:** Do we agree `sign-avatar-b-puppet` is the central integration repo for this hackathon, and the other repos are sources/references?
2. **Proposed owners:** Nikos = data/intelligence/recognition; Alex = motion/VRM; Ledi = app/integration/presentation. Any overlap or changes?
3. **Contracts:** Approve README §6.5 as the first structured plan and agree where the canonical sign manifest lives.
4. **Demo inputs:** Pick the same one or two supported examples for all three streams; identify who can verify their ASL accuracy.
5. **Data and access:** How can Nikos's existing builder/results and the GSL recorder/VRM implementation be shared lawfully without redoing work?
6. **Integration and cost:** Agree the first integration checkpoint, a repaint spending cap, and when to freeze features.

**If approved:** add decisions to the README/issue tracker, merge this coordination document, then develop the three components concurrently. This PR intentionally contains **documentation only** and should be reviewed alongside Nikos's [product plan PR #7](../pull/7), not instead of it.
