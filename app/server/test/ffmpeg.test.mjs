// Without ffmpeg on PATH, /api/sign.mp4 answers a clear 503 (not a spawn error); the server binds loopback by default.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PATH = join(tmpdir(), "flux-no-such-dir");   // this test process only: ffmpeg cannot be found
const { createApp } = await import("../index.mjs");
const { serverConfig } = await import("../lib/config.mjs");

const dir = mkdtempSync(join(tmpdir(), "flux-ffmpeg-"));
writeFileSync(join(dir, "HELLO.mp4"), Buffer.alloc(100, 1));
writeFileSync(join(dir, "manifest.json"), JSON.stringify({ HELLO: { gloss: "HELLO", file: "HELLO.mp4", seconds: 1 } }));

let app, base;
before(async () => {
  app = createApp({ clipsDirs: [dir], semantic: false, recognizerUrl: "http://127.0.0.1:1", log: () => {} });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app?.server.close(); rmSync(dir, { recursive: true, force: true }); });

test("sign.mp4 without ffmpeg: 503 no_ffmpeg that says so", async () => {
  const res = await fetch(`${base}/api/sign.mp4?text=hello&agent=off`);
  assert.equal(res.status, 503);
  const { error } = await res.json();
  assert.equal(error.code, "no_ffmpeg");
  assert.match(error.message, /ffmpeg is not on PATH/);
});

test("HOST defaults to 127.0.0.1; HOST / PORT override it", () => {
  assert.deepEqual([serverConfig({}, {}).host, serverConfig({}, {}).port], ["127.0.0.1", 8787]);
  assert.deepEqual([serverConfig({}, { HOST: "0.0.0.0", PORT: "9000" }).host, serverConfig({}, { PORT: "9000" }).port], ["0.0.0.0", 9000]);
});
