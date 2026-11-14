// fal input shapes checked against the endpoint API pages on 15 Nov 2026.
// Pricing is a conservative planning reserve, never a guaranteed account cap.

const rounding = (value) => Math.ceil(value * 100) / 100;

export const MODELS = Object.freeze({
  recast: {
    endpoint: "minimax/h3-max/recast",
    schema: "https://fal.ai/models/minimax/h3-max/recast/api",
    pricing: "https://fal.ai/models/minimax/h3-max/recast",
    maxSeconds: 30, minSeconds: 5,
    executable: true,
    estimate: (seconds, resolution) => rounding(Math.max(seconds, 5) * (resolution === "1080P" ? 0.65 : 0.50)),
    input: ({ videoUrl, avatarUrl, resolution }) => ({ video_url: videoUrl,
      reference_image_urls: [avatarUrl], resolution, enable_safety_checker: true }),
  },
  kling: {
    endpoint: "fal-ai/kling-video/v3/standard/motion-control",
    schema: "https://fal.ai/models/fal-ai/kling-video/v3/standard/motion-control/api",
    pricing: "https://fal.ai/models/fal-ai/kling-video/v3/standard/motion-control",
    maxSeconds: 30, minSeconds: 0,
    executable: true,
    estimate: (seconds) => rounding(seconds * 0.20),
    input: ({ videoUrl, avatarUrl }) => ({ video_url: videoUrl,
      image_url: avatarUrl, character_orientation: "video", keep_original_sound: false,
      enable_safety_checker: true }),
  },
  dreamactor: {
    endpoint: "fal-ai/bytedance/dreamactor/v2",
    schema: "https://fal.ai/models/fal-ai/bytedance/dreamactor/v2/api",
    pricing: null,
    maxSeconds: 30, minSeconds: 0,
    executable: false, estimate: () => null,
    input: ({ videoUrl, avatarUrl }) => ({ video_url: videoUrl,
      image_url: avatarUrl, trim_first_second: false, enable_safety_checker: true }),
  },
  one_to_all: {
    endpoint: "fal-ai/one-to-all-animation/14b",
    schema: "https://fal.ai/models/fal-ai/one-to-all-animation/14b/api",
    pricing: null,
    maxSeconds: null, minSeconds: 0,
    executable: false, estimate: () => null,
    input: ({ videoUrl, avatarUrl }) => ({ video_url: videoUrl, image_url: avatarUrl,
      prompt: "Follow the reference motion without changing handshapes or timing.",
      negative_prompt: "extra fingers, changed handshape, missing hands, distorted wrists" }),
  },
});

export function planModel(name, metadata, resolution = "768P") {
  const model = MODELS[name];
  if (!model) throw new Error(`Unknown model ${name}; choose ${Object.keys(MODELS).join(", ")}`);
  if (name === "recast" && !["768P", "1080P"].includes(resolution)) {
    throw new Error("Recast resolution must be 768P or 1080P");
  }
  const warnings = [];
  if (metadata.duration_seconds < model.minSeconds) warnings.push(`requires at least ${model.minSeconds}s of video`);
  if (model.maxSeconds && metadata.duration_seconds > model.maxSeconds) warnings.push(`requires at most ${model.maxSeconds}s of video`);
  if (name === "recast") warnings.push("Recast also requires each shot to be <=15s; cut detection is not automated");
  if (name === "kling") warnings.push("Kling's reference-video guidance assumes a visible human/upper body; puppet acceptance is untested");
  if (!model.executable) warnings.push("Paid execution disabled until current pricing can be bounded");
  return { name, endpoint: model.endpoint, schema_url: model.schema, pricing_url: model.pricing,
    executable: model.executable, estimated_max_usd: model.estimate(metadata.duration_seconds, resolution),
    eligible: !warnings.some((w) => w.startsWith("requires")), warnings };
}
