# 2026-11-15: Lucy realtime, a live repaint of the puppet stream

**Who:** Nikos (with Claude)
**Question:** can fal's live video-to-video model `decart/lucy-2-6/realtime` repaint the 3D puppet stream into our realistic avatar in real time, with the handshapes intact?
**Why it matters:** H3 Max Recast keeps the hands but runs about 15× slower than real time (see the [model race](2026-11-15-fal-model-race.md)). Lucy is the only real-time option on fal. If it held the hands, we could sign sentences on the fly.

## Setup
- **API path.** `@fal-ai/client` 1.11 `fal.realtime.connect("decart/lucy-2-6/realtime")`. The WebSocket only carries signaling. Video goes over WebRTC, peer to peer, between the browser and Decart. The protocol, read from the client's own `realtime/lucy` extension:
  1. The client sends the first input: `{prompt, reference_image_url, enable_prompt_expansion}`.
  2. The server answers with `ready`, then `iceServers` (only Google STUN).
  3. The client sends `offer`, the server sends `answer`, then both sides trade `icecandidate`.
  4. The output comes back as a remote video track.

  Auth: the local server mints a temporary JWT with `POST https://rest.fal.ai/tokens/` `{allowed_apps:["lucy-2-6"], token_expiration:120}`. The browser only ever gets that token. Decart's SDK specs for Lucy 2.5/2.6 are 1280×720 at 30 fps (ideal and max), landscape or portrait. The docs list no session limit.
- **Test page.** `experiments/lucy-realtime/` contains:
  - `token-server.mjs`: serves the page plus `POST /token` and `/save`. It reads the key from `FAL_KEY_FILE`.
  - `index.html` + `app.js`: the page.
  - `run.mjs`: drives headless Chrome with puppeteer-core.
  - `analyze.mjs`: lag and timing analysis.
  - `compare.sh`: builds the frame panels.

  The page plays the puppet mp4 into a **720×1280 portrait canvas**: 540×720 scaled to 720×960, padded with the puppet's backdrop colour. It sends `canvas.captureStream(30)` and runs a 2 s warm-up after the first output frame, then plays the clip **2×**. It records the output with MediaRecorder and logs motion energy for input and output on 36×64 canvases, plus `getStats` once a second.
- **Reference:** `assets/avatar/avatar-main.jpg` (hands up), sent as a 768×1024 JPEG data URI. One extra run used `avatar-hands-down.jpg`.
- **Prompt:** "Substitute the character in the video with the person in the reference image: a woman about 35 with olive skin, brown eyes and a short dark-brown chin-length bob, wearing a plain black long-sleeve crew-neck top, in front of a dark grey vertical-grain wall. Keep her arm, hand and finger positions exactly as in the video." Prompt expansion was left on (the default).
- **Inputs:**
  - `judy-vrm.mp4`: 5.92 s. Repainted earlier by Recast, which gives the reference result.
  - `thank-you-see-you-later-vrm.mp4`: 5.25 s, 4 signs.
- **Browser settings that mattered:**
  - Headless Chrome with `--enable-gpu --use-angle=d3d11 --ignore-gpu-blocklist`. `chrome://gpu` then reports **hardware** video encode and decode, and **hardware WebGL**, on the i7-1355U's Iris Xe. So the live puppet viewer could probably run in headless after all. Without these flags Chrome falls back to software, and the input stream drops to about 10 fps while the clip plays.
  - H264 preferred, matching the Decart SDK default.
  - 3.5 Mbps cap on the sender.
- **Commands:**
  ```bash
  cd experiments/lucy-realtime && npm install && npm run build
  FAL_KEY_FILE=C:/Users/DELL/Desktop/fal-key.txt node token-server.mjs &
  node run.mjs --model lucy-2-6 --clip judy            # also: --clip sentence, --ref hands-down, --model lucy-2-5
  node run.mjs --dry 1 --clip judy                     # free: local WebRTC loopback, checks the pipeline and lag estimator
  node analyze.mjs out/lucy-2-6-judy.json 1.88 2.92 4.17 5.62
  ```

## Result

### Runs

| # | Model | Clip / ref | Input path | Connect → first output frame | Output fps during playback (rendered / RTP) | Streamed |
|---|---|---|---|---|---|---|
| 1 | 2.6 | judy / hands-up | VP8, software | 5.7 s | 10.9 / 12 | 22.1 s |
| 2 | 2.6 | judy / hands-up | VP8, software (an unplanned repeat: a flag bug) | 3.7 s | 12.9 / 16 | 20.1 s |
| 3 | **2.6** | **judy / hands-up** | **H264, GPU** | **4.5 s** | **19.5 / 21** | 20.9 s |
| 4 | 2.6 | sentence / hands-up | H264, GPU | 6.7 s | 14.5 / 20 | 21.9 s |
| 5 | 2.5 | judy / hands-up | H264, GPU | 6.7 s | 4.9 / 15 (uplink collapsed) | 23.5 s |
| 6 | 2.6 | sentence / **hands-down** | H264, GPU | 4.5 s | 14.6 / 22 | 19.6 s |

### Latency (Lucy 2.6, median of runs 1–4 and 6)

| Step | Time |
|---|---|
| Connect → `ready` (token + socket + fal) | 1.9 s |
| Connect → SDP `answer` | 2.5 s |
| Connect → WebRTC connected | 3.2 s |
| **Connect → first output frame** | **4.5 s** (3.7–6.7 s) |
| After the puppet starts moving, the output stays in the reference photo's pose for | 0.7 s (judy, hands-up) up to about 2.5 s (sentence, hands-down, first loop) |
| **Steady-state lag, puppet pose → same pose in the output** | **about 0.5–0.6 s** by matching poses frame by frame; 0.9–1.1 s by motion-energy cross-correlation (weak, r = 0.15–0.34; Lucy smooths onsets, so treat this as an upper bound) |
| Output resolution | **720×1280** (portrait was accepted as is) |
| Output fps | **14–21 fps**, not the nominal 30. Lucy outputs at the rate frames arrive: it followed our input fps |

- **Uplink was the bottleneck.** The server's answer already sets `x-google-start-bitrate=2500`. Even so, `availableOutgoingBitrate` fell to **about 90–250 kbps** within 2 s of every run, and to about 40 kbps in run 5. Lucy was getting a heavily compressed 720×1280 puppet, a confound against fine finger detail. The laptop was also running several other dev servers and uploads at the time.

### Hands

Frames from the recorded output, mapped to the puppet's time with the input's own `mediaTime` stamps plus a 0.55–0.6 s lag. Panels: puppet | Recast (offline) | Lucy.

| Moment | Puppet | Recast | Lucy 2.6 (hands-up ref) | Verdict |
|---|---|---|---|---|
| [judy 1.88 s](../assets/demo/lucy/judy-1.88.png) | index pointing at chin | hand at chest, index curled | loop 1: **two-handed "triangle"**, invented; loop 2: flat hand at chin + a curled second hand | ✗, and different between loops |
| [judy 2.92 s](../assets/demo/lucy/judy-2.92.png) | bent claw hand by chin | flat hand by shoulder | loop 1: **both** hands clawed at chest; loop 2: claw at chin ✓ + an extra fist | partial |
| [judy 4.17 s](../assets/demo/lucy/judy-4.17.png) | index up + thumb hand | index up + thumb hand ✓ | loops 1 and 2: muddled flat or bent hands, index not clear | ✗ |
| [judy 5.62 s](../assets/demo/lucy/judy-5.62.png) | index up, other arm across waist | index up ✓ | loop 1: index + thumb up (L-like), arm across ✓; loop 2: bent fingers, index lost | partial |
| [THANK YOU 1.0 s](../assets/demo/lucy/sentence-thankyou-1.0.png) | flat hand at chest | flat hand ✓ | flat hand at chest ✓ (with the hands-down ref: **no hand**, it kept the resting pose) | ✓ with hands-up ref only |
| [SEE 2.6 s](../assets/demo/lucy/sentence-see-2.6.png) | V by the face | V ✓ | hands-up ref: **two open palms, V gone**; hands-down ref: V by the face ✓ (fingers close together) | ✓ with hands-down ref only |
| [LATER 4.7 s](../assets/demo/lucy/sentence-later-4.7.png) | index hooked up | index up ✓ | thumb-up fist + an invented open palm; hands-down ref: thumb-up fist | ✗ |

- **[Sentence strip](../assets/demo/lucy/sentence-strip.png)** (0.5 s steps, second loop, lag-aligned). Rows: puppet, Lucy with the hands-up ref, Lucy with the hands-down ref.
- **It invents hands from the reference photo.** With `avatar-main.jpg` (both palms raised), the raised open palms keep coming back: at the start, whenever a puppet hand is low or out of frame, and sometimes alongside the real signing hand, so up to **3–4 hands are visible at once** (sentence, 0.75–2.0 s). A **hands-down reference stops the extra hands**, but then the model clings to the resting pose: THANK YOU is skipped on both loops.
- **Location** is roughly kept, at chest or chin height like the puppet, and closer to the face than Recast in places.
- **Not deterministic.** The same puppet frame gives different handshapes on loop 1 and loop 2.
- **Identity.**
  - Hands-up ref: clearly our avatar (bob, black top, dark wall), realistic skin, stable face, no flicker.
  - Hands-down ref: the face **drifts toward the puppet's anime look**, with big round eyes.
  - Both: small white blobs at the bottom edge, where the puppet's white shirt and feet show.
- **Lucy 2.5 (run 5)** sat frozen in one pose for about 4 s and then lagged. With the uplink collapsed in that run, this isn't a fair model comparison.

### Cost
128 s streamed in total across 6 sessions (from socket open to close) × $0.02/s = **≈ $2.56** at most. The billed amount isn't in the API response; check the fal dashboard. About $0.40 of that is run 2, an unplanned repeat caused by a driver flag bug.

## What I learned
- **The "real time" part works.** 720×1280 output, about 0.5–0.6 s behind the puppet, our avatar's identity held, and $0.02 per second. The 4.5 s connect time can be hidden by opening the session before the user needs it, streaming the idle puppet in the meantime.
- **Hand fidelity is not good enough for signing.** At best a handshape comes through (THANK YOU flat hand, SEE V with the right reference, judy 5.62 index). Often it's lost, merged into the reference photo's pose, or doubled with an invented second hand, and the same frame isn't repeatable. Recast is clearly more faithful on the same frames.
- **The reference image steers the pose, not just the look.** That's a real lever, and a trap: a hands-up photo invents hands, a hands-down photo suppresses signs.
- **Verdict: not usable as-is for on-the-fly ≤ 5 s signing.** It could be a "live preview" or a non-signing idle avatar. It can't replace Recast or the pre-rendered per-sign clips for content that has to be read.

## What I'd try next
1. **A neutral reference** (hands out of frame, or a head-and-shoulders crop), prompt expansion off, and a prompt that says "exactly two hands". This tests whether the invented hands come from the reference or from the model.
2. **A better uplink** (wired, nothing else uploading) and check `availableOutgoingBitrate` stays above 2 Mbps. The puppet's fingers reach Lucy at about 150 kbps today.
3. **Puppet framing:** zoom in so the hands are bigger in the 720×1280 frame, and keep both hands in frame always (no arms down at the sides). Lucy hallucinates whenever it can't see a hand.
4. **Render the puppet live in GPU headless Chrome** (`--enable-gpu --use-angle=d3d11` gives hardware WebGL here) and send that canvas, instead of the mp4 stand-in.
5. Have a fluent signer look at `out/lucy-2-6-*.mp4` before any further spend.
