// Demo page for src/player.ts (player.html): fetch sign motions, join them, play at once, show how long it took.
import { SignerPlayer } from "./player";

/** local paths go through the dev server's /__file/ route (vite.config.ts), like the viewer */
const resolveUrl = (p: string) =>
  /^(https?:|blob:|data:)/.test(p) || (p.startsWith("/") && !/^\/[a-zA-Z]\//.test(p)) ? p
    : "/__file/" + p.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");

declare global { interface Window { playerStats: Promise<Record<string, number>> } }

const q = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;

async function run(): Promise<Record<string, number>> {
  const t0 = performance.now();
  const signs = (q.get("signs") ?? "/fixtures/wave.json").split(",").filter(Boolean);
  const canvas = $("c") as HTMLCanvasElement;
  const playerP = SignerPlayer.create(canvas, { modelUrl: q.get("model") ?? undefined });
  const motions = await Promise.all(signs.map(async (s) => (await fetch(resolveUrl(s))).json()));
  const player = await playerP;
  const tReady = performance.now();
  const info = player.loadSentence(motions);
  const tBaked = performance.now();
  let drawn = 0;
  const tPlay = performance.now();
  const done = player.play({ loop: q.get("loop") === "1", onFrame: (_f, sign) => { drawn++; $("sign").textContent = sign ?? ""; } });
  const stats = {
    load_ms: Math.round(tReady - t0), bake_ms: Math.round(tBaked - tReady), first_frame_ms: Math.round(tBaked - tReady + 16),
    frames: info.frames, seconds: +info.seconds.toFixed(2),
  };
  $("status").textContent = `${signs.length} sign(s), ${info.frames} frames · avatar+motions loaded ${stats.load_ms} ms · solved ${stats.bake_ms} ms`;
  if (q.get("loop") === "1") return stats;
  await done;
  const fps = drawn / ((performance.now() - tPlay) / 1000);
  $("status").textContent += ` · played at ${fps.toFixed(0)} fps`;
  return { ...stats, play_fps: +fps.toFixed(1) };
}

window.playerStats = run();
window.playerStats.catch((e) => { $("status").textContent = String(e?.stack ?? e); console.error(e); });
