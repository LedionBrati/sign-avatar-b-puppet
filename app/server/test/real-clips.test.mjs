// Smoke test on the real clip set (default CLIPS_DIR). Skipped when the clips or ffmpeg are not on this machine.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../index.mjs";
import { parseClipsDirs } from "../lib/clips.mjs";

const dir = parseClipsDirs()[0];
const noClips = !existsSync(join(dir, "manifest.json")) && `no clips at ${dir}`;
let hasFfmpeg = true;
try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { hasFfmpeg = false; }

let app, base;
before(async () => {
  if (noClips) return;
  app = createApp({ clipsDirs: [dir], semantic: false, log: () => {} });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app?.server.close());

test("real clips: Range on an mp4 returns the exact bytes", { skip: noClips }, async () => {
  const { playlist } = await (await fetch(`${base}/api/sign`, { method: "POST", body: JSON.stringify({ text: "Thank you, see you later." }) })).json();
  assert.deepEqual(playlist.map((p) => p.motion_id), ["THANK_YOU", "SEE", "YOU", "LATER"]);
  const file = readFileSync(join(dir, "THANK_YOU.mp4"));
  const res = await fetch(base + playlist[0].url, { headers: { range: "bytes=1000-5999" } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("content-range"), `bytes 1000-5999/${file.length}`);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(file.subarray(1000, 6000)));
});

test("real clips: /api/sign.mp4 joins the playlist", { skip: noClips || (!hasFfmpeg && "no ffmpeg") }, async () => {
  const res = await fetch(`${base}/api/sign.mp4?text=${encodeURIComponent("Where does it hurt?")}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 10_000);
  assert.equal(buf.subarray(4, 8).toString(), "ftyp");
  const none = await fetch(`${base}/api/sign.mp4?text=Xylophone`);
  assert.equal(none.status, 422);
  assert.equal((await none.json()).error.code, "signing_not_supported"); // safety gate (docs/semantic-safety.md) answers first
  assert.equal((await fetch(`${base}/api/sign.mp4`)).status, 400);
});
