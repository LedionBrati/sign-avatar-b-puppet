import test from "node:test";
import assert from "node:assert/strict";
import { chromeCandidates, findChrome } from "./find-chrome.mjs";

test("CHROME wins over every install location", () => {
  assert.equal(findChrome({ env: { CHROME: "/opt/my/chrome" }, exists: () => true }), "/opt/my/chrome");
});

test("first existing standard location per platform", () => {
  const env = { PROGRAMFILES: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
  const local = "C:/Users/me/AppData/Local/Google/Chrome/Application/chrome.exe";
  assert.equal(findChrome({ env, platform: "win32", exists: (p) => p === local }), local);
  assert.equal(chromeCandidates({ env, platform: "win32" })[0], "C:/Program Files/Google/Chrome/Application/chrome.exe");
  assert.equal(findChrome({ env: {}, platform: "darwin", exists: (p) => p.startsWith("/Applications/Google") }),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(findChrome({ env: {}, platform: "linux", exists: (p) => p === "/usr/bin/chromium" }), "/usr/bin/chromium");
});

test("clear error when Chrome is nowhere", () => {
  assert.throws(() => findChrome({ env: {}, platform: "linux", exists: () => false }), /Chrome not found.*set CHROME=/);
});
