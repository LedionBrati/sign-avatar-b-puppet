// fal queue calls for produce.mjs, split so a request id is saved BEFORE we wait for the result: a crash after
// submit resumes by polling the same request instead of paying again. Only loaded in paid mode.
// FAL_KEY from the environment (or FAL_KEY_FILE); never logged, never passed to child processes.

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const TYPES = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

export function falKey(env = process.env) {
  if (env.FAL_KEY) return env.FAL_KEY.trim();
  if (env.FAL_KEY_FILE) return readFileSync(env.FAL_KEY_FILE, "utf8").trim();
  return null;
}

export async function falClient(key) {
  if (!key) throw new Error("FAL_KEY (or FAL_KEY_FILE) is required for paid execution");
  const { fal } = await import("@fal-ai/client");
  fal.config({ credentials: key });
  return {
    /** Local file -> fal storage URL (free). */
    async upload(path) {
      const file = new File([readFileSync(path)], basename(path), { type: TYPES[extname(path).toLowerCase()] ?? "application/octet-stream" });
      return fal.storage.upload(file);
    },
    /** The billed call. Returns the request id as soon as fal has the job. */
    async submit(endpoint, input) {
      const { request_id } = await fal.queue.submit(endpoint, { input });
      return request_id;
    },
    /** Wait for a submitted request; returns its result data. */
    async wait(endpoint, requestId, { timeoutMs = 45 * 60_000, everyMs = 5000, onStatus = () => {} } = {}) {
      const t0 = Date.now();
      for (;;) {
        const st = await fal.queue.status(endpoint, { requestId, logs: false });
        onStatus(st.status);
        if (st.status === "COMPLETED") break;
        if (Date.now() - t0 > timeoutMs) throw Object.assign(new Error(`${requestId}: still ${st.status} after ${Math.round(timeoutMs / 60000)} min`), { code: "timeout" });
        await new Promise((r) => setTimeout(r, everyMs));
      }
      const res = await fal.queue.result(endpoint, { requestId });
      return res.data;
    },
  };
}

export async function download(url, outPath) {
  const { writeFileSync } = await import("node:fs");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}
