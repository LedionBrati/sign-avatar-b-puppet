// Shared helpers for the fal scripts.
// - reads FAL_KEY from the environment (never hard-code it)
// - uploads local files to fal storage
// - runs a model through the fal queue and waits for the result
// - downloads result files

import { fal } from "@fal-ai/client";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";

if (!process.env.FAL_KEY) {
  console.error("FAL_KEY is not set. Run: export FAL_KEY=your_key (see README, Setup).");
  process.exit(1);
}
fal.config({ credentials: process.env.FAL_KEY });

const TYPES = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/** Local path -> fal URL. A value that already starts with http is returned as is. */
export async function toUrl(pathOrUrl) {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  const bytes = await readFile(pathOrUrl);
  const type = TYPES[extname(pathOrUrl).toLowerCase()] || "application/octet-stream";
  const file = new File([bytes], basename(pathOrUrl), { type });
  return fal.storage.upload(file);
}

/** Run a model and wait. Returns { data, requestId, seconds }. */
export async function run(endpoint, input) {
  const t0 = Date.now();
  const result = await fal.subscribe(endpoint, {
    input,
    logs: false,
    onQueueUpdate: (u) => process.stderr.write(`\r${endpoint}: ${u.status}        `),
  });
  process.stderr.write("\n");
  return { data: result.data, requestId: result.requestId, seconds: Math.round((Date.now() - t0) / 1000) };
}

export async function download(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}

/** Tiny CLI flag reader: arg("video") reads --video <value>. */
export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) {
    if (fallback === undefined) {
      console.error(`Missing --${name}`);
      process.exit(1);
    }
    return fallback;
  }
  return process.argv[i + 1];
}
