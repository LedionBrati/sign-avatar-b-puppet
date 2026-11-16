// Race candidates: every fal model that can turn our reference render into the realistic avatar.
// Prices and fields read from the fal model pages / OpenAPI schemas on 16 Nov 2026 (see
// experiments/2026-11-16-finger-fidelity.md). `cost(v)` is the price for ONE call on video v
// ({seconds, frames, fps, width, height}); `exact: false` marks a price we could not fully pin down,
// which then counts as a reserve (upper bound), and `verified: false` blocks paid mode for that model.
//
// needs: which reference videos the model takes. rgb = the render, pose = DWPose-style skeleton
// (motion/render_pose.py), depth / normal = depth or normal render of the 3D avatar.

const usd = (v) => Math.ceil(v * 1000) / 1000;
const recastTokens = (s) => 0.022 * Math.max(0, 6750 * s - 4096) / 1000; // $0.022 per 1k tokens after 4096, ~6750 tokens/s
const perMegapixel = (w, h, frames) => 0.0024075 * Math.ceil(w * h * frames / 1e6);
export const AVATAR_PROMPT = "A real woman in a dark top signs American Sign Language to the camera. Plain dark wall. " +
  "Keep every finger exactly as in the control video: same handshape, same extended and curled fingers.";
const NEGATIVE = "extra fingers, missing fingers, fused fingers, fist instead of open hand, changed handshape, blurry hands";

export const RACE_MODELS = Object.freeze({
  recast: {
    label: "H3 Max Recast 768P (today's pipeline, control)",
    endpoint: "minimax/h3-max/recast", needs: ["rgb"], minSeconds: 5, maxSeconds: 30, shift: 0,
    price: "$0.085/s at 768P (5 s minimum) + $0.022 per 1k input tokens after 4096 (~6750 tokens/s)",
    exact: true, verified: true,
    cost: (v) => usd(0.085 * Math.max(5, v.seconds) + recastTokens(v.seconds)),
    input: ({ rgb, avatar }) => ({ video_url: rgb, reference_image_urls: [avatar], resolution: "768P", enable_safety_checker: true }),
  },
  recast1080: {
    label: "H3 Max Recast 1080P",
    endpoint: "minimax/h3-max/recast", needs: ["rgb"], minSeconds: 5, maxSeconds: 30, shift: 0,
    price: "$0.17/s at 1080P (5 s minimum) + input tokens as above", exact: true, verified: true,
    cost: (v) => usd(0.17 * Math.max(5, v.seconds) + recastTokens(v.seconds)),
    input: ({ rgb, avatar }) => ({ video_url: rgb, reference_image_urls: [avatar], resolution: "1080P", enable_safety_checker: true }),
  },
  h3_3d: {
    label: "H3 Max 3D-to-Video 768P (made for 3D renders)",
    endpoint: "minimax/h3-max/3d-to-video", needs: ["rgb"], minSeconds: 0, maxSeconds: 15, shift: 0,
    price: "$0.50/request + $0.08/s at 768P (5 s minimum per shot) + $0.02 per 1k tokens after 4096 (token rate not published; Recast's 6750/s used as a ceiling)",
    exact: false, verified: true,
    cost: (v) => usd(0.50 + 0.08 * Math.max(5, v.seconds) + 0.02 * Math.max(0, 6750 * v.seconds - 4096) / 1000),
    input: ({ rgb, avatar }) => ({ video_url: rgb, reference_image_urls: [avatar], resolution: "768P" }),
  },
  kling3pro: {
    label: "Kling v3 Pro Motion Control",
    endpoint: "fal-ai/kling-video/v3/pro/motion-control", needs: ["rgb"], minSeconds: 3, maxSeconds: 30, shift: 0,
    price: "$0.168 per output second", exact: true, verified: true,
    cost: (v) => usd(0.168 * v.seconds),
    input: ({ rgb, avatar }) => ({ video_url: rgb, image_url: avatar, character_orientation: "video",
      keep_original_sound: false, prompt: AVATAR_PROMPT }),
  },
  kling3std: {
    label: "Kling v3 Standard Motion Control",
    endpoint: "fal-ai/kling-video/v3/standard/motion-control", needs: ["rgb"], minSeconds: 3, maxSeconds: 30, shift: 0,
    price: "$0.126 per output second", exact: true, verified: true,
    cost: (v) => usd(0.126 * v.seconds),
    input: ({ rgb, avatar }) => ({ video_url: rgb, image_url: avatar, character_orientation: "video", keep_original_sound: false }),
  },
  dreamactor: {
    label: "ByteDance DreamActor v2",
    endpoint: "fal-ai/bytedance/dreamactor/v2", needs: ["rgb"], minSeconds: 0, maxSeconds: 30, shift: 36,
    price: "$0.05 per second (adds a ~1 s lead-in; the metric searches the offset)", exact: false, verified: true,
    cost: (v) => usd(0.05 * (v.seconds + 1)),
    input: ({ rgb, avatarSmall }) => ({ video_url: rgb, image_url: avatarSmall, trim_first_second: false, enable_safety_checker: true }),
  },
  ltx_r2r: {
    label: "LTX 2.3 Render-to-Real (CG render -> real, identity from first frame only)",
    endpoint: "fal-ai/ltx-2.3-quality/render-to-real", needs: ["rgb"], minSeconds: 0, maxSeconds: 20, shift: 0,
    price: "$0.0024075 per megapixel (W x H x frames, rounded up); 720p 3:4 = 720x960", exact: true, verified: true,
    cost: (v) => usd(perMegapixel(720, 960, ltxFrames(v.frames))),
    input: ({ rgb, firstFrame, avatar }, v) => ({ video_url: rgb, image_url: firstFrame ?? avatar, intensity: "strong-v2",
      resolution: "720p", num_frames: ltxFrames(v.frames), frames_per_second: Math.round(v.fps), enable_detail_refine: false,
      generate_audio: false }),
  },
  ltx_ic_pose: {
    label: "LTX 2.3 reference v2v, our pose video as control",
    endpoint: "fal-ai/ltx-2.3-quality/reference-video-to-video", needs: ["rgb", "pose"], minSeconds: 0, maxSeconds: 20, shift: 0,
    price: "$0.0024075 per megapixel, as above", exact: true, verified: false,
    cost: (v) => usd(perMegapixel(720, 960, ltxFrames(v.frames))),
    input: ({ rgb, pose, avatar }, v) => ({ prompt: AVATAR_PROMPT, video_url: rgb, control_video_url: pose,
      skip_control_preprocess: true, image_url: avatar, num_frames: ltxFrames(v.frames), frames_per_second: Math.round(v.fps), resolution: "720p" }),
  },
  vace_pose: {
    label: "Wan 2.2 VACE Fun A14B, our pose video (hands included), no re-detection",
    endpoint: "fal-ai/wan-22-vace-fun-a14b/pose", needs: ["pose"], minSeconds: 0, maxSeconds: 15, shift: 0,
    price: "$0.10/s at 720p, seconds = frames / 16 (deprecated, removed 4 Jan 2027)", exact: false, verified: true,
    cost: (v) => usd(0.10 * v.frames / 16),
    input: ({ pose, avatar }, v) => ({ prompt: AVATAR_PROMPT, negative_prompt: NEGATIVE, video_url: pose, preprocess: false,
      ref_image_urls: [avatar], match_input_num_frames: true, match_input_frames_per_second: true, resolution: "720p",
      aspect_ratio: "auto", num_frames: Math.min(241, v.frames) }),
  },
  vace_depth: {
    label: "Wan 2.2 VACE Fun A14B, our depth render",
    endpoint: "fal-ai/wan-22-vace-fun-a14b/depth", needs: ["depth"], minSeconds: 0, maxSeconds: 15, shift: 0,
    price: "$0.10/s at 720p, seconds = frames / 16 (deprecated, removed 4 Jan 2027)", exact: false, verified: true,
    cost: (v) => usd(0.10 * v.frames / 16),
    input: ({ depth, avatar }, v) => ({ prompt: AVATAR_PROMPT, negative_prompt: NEGATIVE, video_url: depth, preprocess: false,
      ref_image_urls: [avatar], match_input_num_frames: true, match_input_frames_per_second: true, resolution: "720p",
      aspect_ratio: "auto", num_frames: Math.min(241, v.frames) }),
  },
  scail2: {
    label: "SCAIL-2 (3D-aware character animation)",
    endpoint: "fal-ai/scail-2", needs: ["rgb"], minSeconds: 0, maxSeconds: 6.7, shift: 0,
    price: "$0.20/s (search snippet only; page and schema returned 404)", exact: false, verified: false,
    cost: (v) => usd(0.20 * v.seconds),
    input: ({ rgb, avatar }) => ({ video_url: rgb, image_url: avatar, prompt: AVATAR_PROMPT }),
  },
});

/** LTX wants 8n+1 frames. */
export function ltxFrames(frames) {
  return Math.min(481, Math.max(9, Math.ceil((frames - 1) / 8) * 8 + 1));
}

/** Plan one model on a reference: eligibility, the clip it will actually get (padded to its minimum), and the cost. */
export function planRace(name, ref, have) {
  const m = RACE_MODELS[name];
  if (!m) throw new Error(`Unknown model ${name}; choose ${Object.keys(RACE_MODELS).join(", ")}`);
  const missing = m.needs.filter((k) => !have[k]);
  const padTo = ref.seconds < m.minSeconds ? m.minSeconds + 0.05 : null;
  const billed = padTo ? { ...ref, seconds: padTo, frames: Math.ceil(padTo * ref.fps) } : ref;
  const problems = [...missing.map((k) => `needs a ${k} video`),
    ...(ref.seconds > m.maxSeconds ? [`longer than its ${m.maxSeconds}s limit`] : [])];
  return { name, label: m.label, endpoint: m.endpoint, needs: m.needs, price: m.price, exact: m.exact, verified: m.verified,
    pad_to_seconds: padTo, billed_seconds: Number(billed.seconds.toFixed(3)), cost_usd: m.cost(billed),
    eligible: problems.length === 0, problems };
}
