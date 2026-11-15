# SIGNLAYER extension: 2030 design

One quiet floating object. The signer is the hero; everything else stays out of the way until asked for.

- **Card.** A single frosted-glass card (backdrop blur + saturation on the iframe, continuous corners via `corner-shape: squircle`, a specular rim, layered soft shadows). Light or dark glass follows the page's own background (YouTube's dark theme, any dark site, fullscreen).
- **Stage.** The 3:4 clips are shown full frame, so the head and both hands are always visible. Two stacked videos: the next clip preloads and crossfades in on top (100 ms) on its first painted frame while the old one stays visible underneath, so there is never a black frame. Clip speed follows the page video's rate; the signer pauses with it.
- **Island.** A Dynamic-Island-style capsule (Listening · Signing HELLO · Can't sign yet · Paused · Offline). Its width springs to each label and the label blurs in.
- **Controls.** None at rest. Pointer movement expands the island into a toolbar (size, captions, source, close) in the empty band above the signer's head, never over the hands; it folds back after 2.6 s of stillness. 44 px hit targets.
- **Captions.** A fixed two-line sheet (the card never jumps). Words blur in, the word being signed gets a soft cobalt highlight, lines are balanced. Upcoming words still meet 4.5:1.
- **Can't sign yet.** The neutral pose becomes a soft blurred still, the exact caption comes forward large, and the reason sits underneath. Calm, never broken.
- **Motion.** Springs sampled into CSS `linear()` (`--spring`, `--spring-bounce`, `--spring-snappy` in `lib/base.css`). Drag has momentum and magnetic corners. `prefers-reduced-motion` turns it all off.
- **Popup.** A settings sheet: one switch, a segmented control with a spring thumb, a status dot with the signs count; size, captions, server and shortcuts live under Advanced. Onboarding is one screen.
- **Type and colour.** System font stack (`-apple-system, "SF Pro Text", Inter, system-ui`), cobalt `#1f3fd6` as the only accent, refined squircle mark.

Captures (`scripts/capture-2030.mjs`, `scripts/verify-youtube.mjs`, `scripts/verify-tab-page.mjs`, real Chrome, real YouTube): `2030-signing`, `2030-overlay-m`, `2030-hover-controls`, `2030-source-menu`, `2030-overlay-l`, `2030-size-s-card`, `2030-caption-only-card`, `2030-dark-caption-only`, `2030-dark-hover`, `2030-fullscreen`, `2030-tab-audio`, `2030-popup`, `2030-onboarding`, `2030-dark-popup`, `2030-dark-onboarding`.
