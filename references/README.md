# Reference clips (real signers)

The avatar copies these. **The avatar can only be as correct as the signer.**
The 4 clips here are a starting point. Finding better ones is one of the most useful things anyone can do.

> **Heads up: these 4 clips are full sentences, not single signs.** They are great for testing motion extraction and the puppet (checkpoint 1 and 2 in the main README). They are **not** a sign dictionary: you can't just cut "HELLO" out of them without knowing exactly where each sign starts and ends. For the dictionary, use word-level sources (ASL Signbank, ASL Citizen, WLASL in the table below) or record our own. Always note where a clip came from and its license.

## What's included

From **How2Sign** (Duarte et al., CVPR 2021, https://how2sign.github.io/), validation split, front camera. Cropped to 540x720 (3:4), 24 fps, no audio, with `pipeline/prepare-clip.sh`.

| File | Signer | Length | English | Original clip id |
|---|---|---|---|---|
| `how2sign/judy.mp4` | 3 | 5.9 s | Hi, I'm Judy Carrier with Jewels by Park Lane and I'm going to tell you how to clean your sterling silver jewelry. | `Enhria4v_jo_0-3-rgb_front` |
| `how2sign/travis.mp4` | 3 | 6.1 s | Hi, I'm Travis and I'm about to teach you exactly how you can do that, when you're on the basketball court. | `bBHYQCDp_9A_1-3-rgb_front` |
| `how2sign/dave.mp4` | 5 | 8.4 s | Hi, my name is Dave Schoeneck and we're talking about how you're going to feel after your first day of adaptive skiing. | `DKOzSnHwSFI_0-5-rgb_front` |
| `how2sign/floyd.mp4` | 5 | 11.5 s | Hi, my name's Floyd, I'm talking to you today from theacousticmusician.com in Sandy, Utah, and we're going to talk about how to read guitar music today. | `5Gw0TpbCMTQ_0-5-rgb_front` |

**License: CC BY-NC 4.0, research and non-commercial use only.** Credit the authors and say the video was changed. Never use these in a paid product. That is also why this repo is private.

### How2Sign facts we learned
- Green screen behind the signer (pale, uneven green; use an AI background remover, not a color key).
- Front and side camera views, 1280x720, mostly 24 fps (some 60 fps).
- Sentence-level clips with English text in `how2sign_val.csv` (tab-separated: `SENTENCE_NAME`, `START`, `END`, `SENTENCE`).
- The suffix in the clip id (`-1`, `-3`, `-5`, `-8`) is the signer.
- Signers 1 (man, teal shirt), 3 (slim woman, navy top, red chair), 5 (woman, glasses, black top), 8 (woman, purple shirt, smaller in frame).
- No per-clip download: the smallest pack is `val_rgb_front_clips.zip` (1.7 GB). Download, extract the clips you want with `unzip -j`, delete the zip.
- Sentences come from "how to" videos, so many start with "Hi, I'm [name]". Good for fingerspelling tests.

## Where to find more

| Source | What it is | Good for | License (check yourself) |
|---|---|---|---|
| [How2Sign](https://how2sign.github.io/) | 80+ hours, sentence-level, green screen, English text | Full sentences, method B pose data | CC BY-NC 4.0, research only |
| [ASL Signbank (Yale)](https://aslsignbank.haskins.yale.edu/) | One clean clip per sign, no watermark | **The motion dictionary** (one sign per clip) | CC BY-NC-SA 4.0 (see its conditions page) |
| [ASL Citizen (Microsoft)](https://www.microsoft.com/en-us/research/project/asl-citizen/) | 83k clips, 2.7k signs, 52 signers on webcams | Many versions of each sign | Microsoft Research license, non-commercial |
| [ASL STEM Wiki (Microsoft)](https://www.microsoft.com/en-us/research/project/asl-stem-wiki/datasheet/) | 64k sentence videos, 1 professional interpreter | One consistent signer, full sentences | Check the video license |
| [ASLLRP (Boston University)](https://www.bu.edu/asllrp/) | Annotated continuous signing, linguistic detail | Grammar, facial expressions | Check access terms |
| WLASL | Word-level clips collected from the web | Many signs | Mixed sources, research only |
| Record our own | A Deaf signer, paid, with consent | **The real product** | Ours, if the contract says so |

## What makes a good reference clip

- One signer, facing the camera, waist up, both hands always in frame
- Plain background (green screen is great), even light, sharp
- No captions or watermark over the hands or body
- **Slim build** if you use our avatar (Recast keeps the body build)
- Starts and ends in a **rest pose** (hands down), which makes blending signs easier
- 24 or 30 fps; fast fingerspelling looks better at higher fps and with less motion blur
- A license that allows what you want to do with it

## Adding a clip

1. Put the raw file somewhere outside the repo (raw datasets are big).
2. `./pipeline/prepare-clip.sh raw.mp4 references/<source>/<name>.mp4 [x_offset]`
3. Check a few frames: are both hands inside the frame the whole time?
4. Add a row to the table above: file, signer, length, English text, original id, license.
