// Small helpers shared by the root scripts (setup, assets, test). Cross-platform: no bash, no POSIX-only tools.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";

const paint = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint("1");
export const dim = paint("2");
export const green = paint("32");
export const yellow = paint("33");
export const red = paint("31");

export const step = (s) => console.log(`\n${bold("==>")} ${bold(s)}`);
export const ok = (s) => console.log(`  ${green("ok")}   ${s}`);
export const warn = (s) => console.log(`  ${yellow("warn")} ${s}`);
export const fail = (s) => console.log(`  ${red("fail")} ${s}`);

/**
 * Run a command line, streaming its output. `cmd` is a whole command line (run through the shell so npm.cmd,
 * uv.exe etc. resolve on Windows); keep paths out of it and use `cwd` instead.
 */
export function run(cmd, { cwd = REPO, env, quiet = false } = {}) {
  if (!quiet) console.log(dim(`  $ ${cmd}${cwd !== REPO ? `   (in ${cwd.slice(REPO.length + 1).replaceAll("\\", "/")})` : ""}`));
  const r = spawnSync(cmd, { cwd, env: env ? { ...process.env, ...env } : process.env, shell: true, stdio: quiet ? "pipe" : "inherit" });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout?.toString() ?? "" };
}

/** Is `name` on PATH? */
export function has(name) {
  return (WIN ? spawnSync("where", [name], { stdio: "ignore" }) : spawnSync(`command -v ${name}`, { shell: true, stdio: "ignore" })).status === 0;
}

/** [major, minor] of the running Node. */
export function nodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return [major, minor];
}

export const NODE_MIN = [22, 18];
export const nodeOk = () => {
  const [ma, mi] = nodeVersion();
  return ma > NODE_MIN[0] || (ma === NODE_MIN[0] && mi >= NODE_MIN[1]);
};
