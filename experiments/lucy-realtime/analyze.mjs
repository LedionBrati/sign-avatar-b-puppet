// Offline analysis of a saved session JSON (out/<model>-<clip>.json):
// - motion-energy cross-correlation lag (overall and per loop), with the correlation curve peak
// - mapping puppet time -> recording time, so frames can be pulled from the recorded output
// Usage: node analyze.mjs out/lucy-2-6-judy.json [t1 t2 ...]   (puppet times in seconds)
import fs from "node:fs";

const [file, ...times] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(file, "utf8"));
const { events, inSeries, outSeries } = j;

function resample(series, from, to, step) {
  const out = [];
  let k = 0;
  for (let t = from; t <= to; t += step) {
    while (k + 1 < series.length && series[k + 1][0] <= t) k++;
    out.push(series[k][1]);
  }
  return out;
}
const z = (a) => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) || 1;
  return a.map((x) => (x - m) / sd);
};
function xcorr(from, to, maxLag = 3000, step = 20) {
  const a = z(resample(inSeries, from, to, step));
  const b = z(resample(outSeries, from, to + maxLag, step));
  const curve = [];
  for (let k = 0; k <= maxLag / step; k++) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * (b[i + k] ?? 0);
    curve.push([k * step, s / a.length]);
  }
  const best = curve.reduce((p, c) => (c[1] > p[1] ? c : p));
  return { lagMs: best[0], r: +best[1].toFixed(3), curve };
}

const loopStartWall = [];
for (let i = 1; i < inSeries.length; i++) if (inSeries[i][3] !== inSeries[i - 1][3]) loopStartWall.push(inSeries[i][0]);
const playStart = events.playStart, playEnd = events.playEnd;
const overall = xcorr(playStart, playEnd);
const loops = [playStart, ...loopStartWall, playEnd];
const perLoop = [];
for (let i = 0; i + 1 < loops.length; i++) {
  const r = xcorr(loops[i], loops[i + 1]);
  perLoop.push({ loop: i, lagMs: r.lagMs, r: r.r });
}
// top 3 local maxima of the overall curve (helps spot ambiguous peaks)
const peaks = overall.curve
  .filter((c, i, a) => i > 0 && i < a.length - 1 && c[1] > a[i - 1][1] && c[1] >= a[i + 1][1])
  .sort((p, q) => q[1] - p[1])
  .slice(0, 3)
  .map(([l, r]) => ({ lagMs: l, r: +r.toFixed(3) }));

// output frame intervals during playback -> fps + worst gap
const outPlay = outSeries.filter((x) => x[0] >= playStart && x[0] <= playEnd);
const gaps = outPlay.slice(1).map((x, i) => x[0] - outPlay[i][0]);
const fps = (outPlay.length - 1) / ((outPlay.at(-1)[0] - outPlay[0][0]) / 1000);
const sorted = [...gaps].sort((a, b) => a - b);

const result = {
  file,
  lag: { overall: { lagMs: overall.lagMs, r: overall.r }, peaks, perLoop },
  outputFps: +fps.toFixed(1),
  frameGapMs: { median: Math.round(sorted[sorted.length >> 1]), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]), max: Math.round(sorted.at(-1)) },
};

// puppet time -> recording time (s), per loop, using the input's own mediaTime stamps + lag
const lag = Number(process.env.LAG_MS || overall.lagMs);
const recStart = events.recorderStart;
if (times.length) {
  result.map = { lagMsUsed: lag, rows: [] };
  for (const t of times.map(Number)) {
    const row = { puppetS: t };
    for (const loop of [0, 1]) {
      const cand = inSeries.filter((x) => x[3] === loop);
      if (!cand.length) continue;
      const best = cand.reduce((p, c) => (Math.abs(c[2] - t) < Math.abs(p[2] - t) ? c : p));
      row[`loop${loop}RecS`] = +((best[0] + lag - recStart) / 1000).toFixed(3);
      row[`loop${loop}InputMediaS`] = +best[2].toFixed(3);
    }
    result.map.rows.push(row);
  }
}
console.log(JSON.stringify(result, null, 1));
