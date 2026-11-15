// The artifact build never runs the semantic layer; this replaces @huggingface/transformers so it is not bundled.
export const pipeline = () => { throw new Error("semantic layer is not part of the artifact build"); };
export const env = {};
