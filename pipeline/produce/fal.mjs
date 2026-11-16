// fal queue calls for produce.mjs, split so a request id is saved BEFORE we wait for the result: a crash after
// submit resumes by polling the same request instead of paying again. Only loaded in paid mode.
// FAL_KEY from the environment (or FAL_KEY_FILE); never logged, never passed to child processes.

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    /**
     * Wait for a submitted request; returns its result data. Network errors and 5xx answers are retried until the
     * timeout (the request id is already in the state, so giving up here costs nothing: the next run polls again).
     * Throws {code: "failed"} only when fal itself says the request failed (4xx on the result, or an error status).
     */
    async wait(endpoint, requestId, { timeoutMs = 60 * 60_000, everyMs = 5000, onStatus = () => {} } = {}) {
      const t0 = Date.now();
      const transient = (e) => { const s = e?.status ?? e?.response?.status; return !s || s >= 500 || s === 429; };
      const timeout = () => Object.assign(new Error(`${requestId}: no result after ${Math.round(timeoutMs / 60000)} min`), { code: "timeout" });
      for (;;) {
        if (Date.now() - t0 > timeoutMs) throw timeout();
        let st;
        try { st = await fal.queue.status(endpoint, { requestId, logs: false }); }
        catch (e) { if (!transient(e)) throw Object.assign(new Error(String(e?.message ?? e)), { code: "failed" }); await sleep(Math.min(60_000, everyMs * 4)); continue; }
        onStatus(st.status);
        if (st.status === "COMPLETED") {
          try { return (await fal.queue.result(endpoint, { requestId })).data; }
          catch (e) { if (!transient(e)) throw Object.assign(new Error(String(e?.body?.detail ? JSON.stringify(e.body.detail) : e?.message ?? e)), { code: "failed" }); }
        } else if (st.status && !["IN_QUEUE", "IN_PROGRESS"].includes(st.status)) {
          throw Object.assign(new Error(`fal status ${st.status}`), { code: "failed" });
        }
        await sleep(everyMs);
      }
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
