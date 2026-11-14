# The avatar

A **made-up, photorealistic woman**, about 35, dark chin-length bob, plain black long-sleeve crew-neck top, dark grey vertical-grain wall, soft window light. She is **not a real person**.

| File | What |
|---|---|
| `avatar-main.jpg` | Hands up at chest height, open palms. **The one we give to Recast.** |
| `avatar-hands-down.jpg` | Same woman, hands resting low (the pose between signs) |
| `avatar-closeup.jpg` | Same woman, head and shoulders (for checking the face stays the same) |
| `wall-plate.jpg` | The empty wall, no person. Background for compositing. |

All images are 1792 x 2400 (3:4).

## How she was made (fal)

1. **4 options** with `google/nano-banana-2.1` (text to image), `aspect_ratio 3:4`, `resolution 2K`. 2 women, 2 men. Only the person description changed between options.
2. **Picked option 1** for: cleanest hands (5 well-separated fingers), most real skin, best match to the framing.
3. **Hands-down and close-up** with `google/nano-banana-2.1/edit`, using option 1 as the reference image.
4. **Wall plate** with `google/nano-banana-2.1/edit`: "Remove the woman completely. Show only the empty background..."

Why the other options lost: one had hair that blended into the dark wall, one had hands too close together, one had a shiny blister-like spot on a palm that would show in every signing frame.

### The main prompt

`[PERSON]` was the only part that changed between options.

> A candid, true-to-life smartphone photo in portrait orientation of [PERSON], with a warm, calm, gentle expression and a slight relaxed smile, looking straight into the camera. Her skin looks real: visible pores, fine lines around the eyes, slightly uneven tone and a few small natural imperfections, no retouching, no beauty filter, no AI gloss, no studio-perfect skin. She is framed from the waist up, standing centered and facing the camera straight on, shoulders square to the lens, with the camera held at chest height. She wears a plain black crew-neck long-sleeve top with no logo, no print and no text, and no jewelry, no watch, no earrings and no glasses. Both hands are raised at chest height, out to the sides of her body with elbows bent, palms open and facing the camera, all five fingers on each hand clearly visible, relaxed and slightly spread, anatomically correct hands, as if she is about to start signing in sign language. Behind her is a plain dark grey to black wall with a fine vertical brushed grain texture, like dark vertical-grain wood or textured wallpaper, filling the whole background. Soft, even daylight from a nearby window lights her face evenly with gentle, natural shadows. Shot on a modern iPhone main camera, natural colors, slight sensor noise, sharp focus on face and hands, ordinary unedited photo. No text, no watermark, no logos anywhere.

`[PERSON]` for the winner:
> a friendly woman about 35 years old with olive skin, brown eyes and short, neat dark-brown hair cut in a chin-length bob

### Hands-down edit

> Use this photo as the reference and make a new photo of the exact same woman. Keep everything identical: the same face and facial features, the same brown eyes, freckles, fine lines and natural skin texture, the same short dark-brown chin-length bob, the same plain black crew-neck long-sleeve top with no logo, the same dark grey vertical-grain wall, the same soft even window light on her face, the same camera at chest height, and the same waist-up 3:4 portrait framing with her centered and facing the camera straight on. Keep the same calm, warm expression with a slight smile, looking into the camera. Change only the pose: both arms are lowered and relaxed, and her hands rest loosely together low in front of her waist, one hand lightly over the other, fingers relaxed and natural, five fingers on each hand, both hands fully inside the frame. This is a neutral resting pose between signs. Same ordinary smartphone photo look, natural colors, real skin with no retouching and no AI gloss. No jewelry, no watch, no text, no logo, no watermark.

## Rules for any new avatar

- **Never use a real person's face** without their written OK. Never a famous person.
- Keep the framing above, so all source clips and avatars stay swappable.
- Check hands at full size before using an image: 5 fingers, no fused or extra fingers, no odd spots on palms.
- A darker top + lighter skin (or the opposite) makes hands easier to read.
- Ideas for later: more avatars (men, older, different skin tones) so users can pick.
