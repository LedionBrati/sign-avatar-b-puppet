// SIGNING_MODE=relaxed: partial sentences sign what they can; skipped words stay listed for the captions.
// Skipped when the real clips are not on this machine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

process.env.SIGNING_MODE = "relaxed";
const { createApp } = await import("../index.mjs");
const { parseClipsDirs } = await import("../lib/clips.mjs");

const dir = parseClipsDirs()[0];
const noClips = !existsSync(join(dir, "manifest.json")) && `no clips at ${dir}`;
let app, base;
before(async () => {
  if (noClips) return;
  app = createApp({ clipsDirs: [dir], semantic: false, log: () => {} });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app?.server.close());

const sign = async (text) => (await fetch(`${base}/api/sign`, { method: "POST", body: JSON.stringify({ text, agent: "off" }) })).json();

test("relaxed: a sentence with a missing word still signs the known words", { skip: noClips }, async () => {
  const r = await sign("Thank you, doctor, see you later.");
  assert.ok(r.playlist.length >= 3, `expected the known signs to play, got ${JSON.stringify(r.playlist.map((p) => p.motion_id))}`);
  assert.equal(r.safety.status, "fully_supported");
  assert.equal(r.safety.mode, "relaxed");
  assert.notEqual(r.safety.strict_status, "fully_supported");
  assert.ok(r.unsupported.map((w) => w.toLowerCase()).includes("doctor"));
});

test("relaxed: a fully supported sentence is unchanged", { skip: noClips }, async () => {
  const r = await sign("Thank you, see you later.");
  assert.deepEqual(r.playlist.map((p) => p.motion_id), ["THANK_YOU", "SEE", "YOU", "LATER"]);
  assert.equal(r.safety.mode, undefined);
});

test("relaxed: nothing signable stays caption only", { skip: noClips }, async () => {
  const r = await sign("Zebra quantum spaghetti.");
  assert.equal(r.playlist.length, 0);
  assert.notEqual(r.safety.status, "fully_supported");
});
