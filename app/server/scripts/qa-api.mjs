// Live API smoke check. Requires the synthetic manifest from make-qa-clips.mjs and a running server.
// API_URL=http://127.0.0.1:8787 node app/server/scripts/qa-api.mjs
import assert from "node:assert/strict";

const base = (process.env.API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const cases = [
  ["Hello, thank you.", "fully_supported"],
  ["Yes, thank you.", "fully_supported"],
  ["No, thank you.", "fully_supported"],
  ["I don't want that.", "caption_only"],
  ["Turn right at the bank.", "needs_confirmation"],
  ["You have to pay a fine.", "needs_confirmation"],
  ["Hello, my name is Maria.", "caption_only"],
  ["My appointment is at 3:30.", "caption_only"],
  ["Xylophone banana.", "caption_only"],
];
for (const [text, expected] of cases) {
  const response = await fetch(base + "/api/sign", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, semantic: false }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.text, text);
  assert.equal(result.safety?.caption, text);
  assert.equal(result.safety?.status, expected, text);
  assert.ok(Array.isArray(result.safety.reasons));
  assert.equal(result.playlist.length > 0, expected === "fully_supported", text);
  const mp4 = await fetch(base + "/api/sign.mp4?semantic=false&text=" + encodeURIComponent(text));
  if (expected === "fully_supported") {
    assert.equal(mp4.status, 200, text);
    assert.equal(Buffer.from(await mp4.arrayBuffer()).subarray(4, 8).toString(), "ftyp");
  } else {
    assert.equal(mp4.status, 422, text);
    const blocked = await mp4.json();
    assert.equal(blocked.safety.caption, text);
    assert.equal(blocked.safety.status, expected);
    assert.deepEqual(blocked.playlist, []);
  }
  console.log(`PASS ${expected.padEnd(18)} POST 200 / MP4 ${mp4.status}: ${text}`);
}

const empty = await fetch(base + "/api/sign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "" }) });
assert.equal(empty.status, 400);
assert.equal((await empty.json()).error.code, "empty_text");
console.log("PASS empty text returns structured HTTP 400");
