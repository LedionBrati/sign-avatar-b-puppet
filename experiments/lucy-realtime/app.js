// Lucy realtime test page.
// Plays a puppet clip into a 720x1280 canvas, streams it to fal's Lucy realtime endpoint over WebRTC
// (fal WebSocket signaling: input -> ready(iceServers) -> offer -> answer -> ICE), shows the output,
// records it with MediaRecorder and measures latency + fps.
//
// Signaling mirrors @fal-ai/client's realtime/lucy extension, written out here so every server message
// (including error payloads) is logged.

import { fal } from "@fal-ai/client";

const q = new URLSearchParams(location.search);
const MODEL = q.get("model") || "lucy-2-6";
const CLIP = q.get("clip") || "judy";
const LOOPS = Math.max(1, Math.min(2, Number(q.get("loops") || 2)));
const WARMUP_MS = Number(q.get("warmup") || 2000);
const TAIL_MS = Number(q.get("tail") || 2500);
const MAX_S = Math.min(40, Number(q.get("max") || 30)); // hard cap per session (cost guard)
const EXPAND = q.get("expand") !== "0";
const DRY = q.get("dry") === "1"; // local loopback instead of Lucy: free check of the input pipeline + lag estimator
const REC = q.get("rec") !== "0"; // MediaRecorder on the output
const REF = q.get("ref") || "main"; // "main" (hands up) or "hands-down"
const W = 720, H = 1280; // Lucy 2.5/2.6: 1280x720, portrait 9:16 supported; 30 fps ideal
const FPS = 30;
const ENDPOINT = `decart/${MODEL}/realtime`;
const PROMPT =
  q.get("prompt") ||
  "Substitute the character in the video with the person in the reference image: a woman about 35 with olive skin, " +
    "brown eyes and a short dark-brown chin-length bob, wearing a plain black long-sleeve crew-neck top, in front of a " +
    "dark grey vertical-grain wall. Keep her arm, hand and finger positions exactly as in the video.";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const t0 = performance.now();
const events = {};
const logLines = [];
function log(...a) {
  const line = `[${((performance.now() - t0) / 1000).toFixed(3)}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
  logLines.push(line);
  logEl.textContent += line + "\n";
  console.log(line);
}
const mark = (name) => {
  if (events[name] === undefined) events[name] = performance.now();
  log("event", name);
};

// ---------- input: puppet video -> padded portrait canvas ----------
const src = $("src");
const inCanvas = $("in");
inCanvas.width = W;
inCanvas.height = H;
const ictx = inCanvas.getContext("2d");
const PUP = { x: 0, y: 160, w: 720, h: 960 }; // 540x720 (3:4) scaled to 720x960, centered vertically

// small canvases for motion energy
const SW = 36, SH = 64;
function makeEnergy() {
  const c = document.createElement("canvas");
  c.width = SW;
  c.height = SH;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  let prev = null;
  return (source, sx, sy, sw, sh) => {
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, SW, SH);
    const d = ctx.getImageData(0, 0, SW, SH).data;
    const g = new Float32Array(SW * SH);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let e = 0;
    if (prev) for (let i = 0; i < g.length; i++) e += Math.abs(g[i] - prev[i]);
    prev = g;
    return e / g.length;
  };
}
const inEnergy = makeEnergy();
const outEnergy = makeEnergy();
const inSeries = []; // [wallMs, energy, mediaTime, loop]
const outSeries = []; // [wallMs, energy, mediaTime]

let loopIdx = 0;
const loopStarts = [];
let lastMediaTime = -1;
function drawInput() {
  ictx.fillStyle = "rgb(28,32,37)"; // puppet backdrop colour
  ictx.fillRect(0, 0, W, H);
  if (src.readyState >= 2) ictx.drawImage(src, PUP.x, PUP.y, PUP.w, PUP.h);
  if (src.currentTime !== lastMediaTime && src.readyState >= 2) {
    lastMediaTime = src.currentTime;
    const e = inEnergy(src, 0, 0, src.videoWidth, src.videoHeight);
    inSeries.push([performance.now(), e, src.currentTime, loopIdx]);
  }
}

// ---------- reference image: avatar -> JPEG data URI (768x1024, >= 512) ----------
async function avatarDataUri() {
  const img = new Image();
  img.src = REF === "hands-down" ? "/media/avatar-hands-down.jpg" : "/media/avatar.jpg";
  await img.decode();
  const c = document.createElement("canvas");
  c.width = 768;
  c.height = 1024;
  c.getContext("2d").drawImage(img, 0, 0, 768, 1024);
  return c.toDataURL("image/jpeg", 0.9);
}


// Same publish settings as Decart's own SDK: seed the bandwidth estimate at 1.1 Mbps via
// x-google-start-bitrate in the remote answer, cap at 3.5 Mbps. Without this, libwebrtc starts
// near 300 kbps and the encoder drops to ~10 fps on moving content.
const START_KBPS = 1100, MAX_BPS = 3_500_000;
function mungeAnswer(sdp) {
  const param = `x-google-start-bitrate=${START_KBPS}`;
  return sdp.split(/(?=^m=)/m).map((sec) => {
    if (!sec.startsWith("m=video")) return sec;
    const withFmtp = new Set([...sec.matchAll(/^a=fmtp:(\d+) /gm)].map((m) => m[1]));
    return sec
      .replace(/^a=fmtp:\d+ [^\r\n]*/gm, (l) => (l.includes(param) ? l : `${l};${param}`))
      .replace(/^a=rtpmap:(\d+) (?!rtx|red|ulpfec|flexfec)[^\r\n]*(\r?\n)/gim, (l, pt, eol) => (withFmtp.has(pt) ? l : `${l}a=fmtp:${pt} ${param}${eol}`));
  }).join("");
}
// Decart's SDK publishes H264 by default; it is also the codec this laptop can encode in hardware.
const CODEC = (q.get("codec") || "h264").toLowerCase();
function preferCodec(peer) {
  const caps = RTCRtpSender.getCapabilities("video");
  if (!caps) return;
  const want = caps.codecs.filter((c) => c.mimeType.toLowerCase() === `video/${CODEC}`);
  const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== `video/${CODEC}`);
  for (const t of peer.getTransceivers()) if (t.sender.track && t.sender.track.kind === "video") t.setCodecPreferences([...want, ...rest]);
}
async function capSender(peer) {
  for (const sender of peer.getSenders()) {
    if (!sender.track || sender.track.kind !== "video") continue;
    const p = sender.getParameters();
    p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = MAX_BPS;
    p.encodings[0].maxFramerate = FPS;
    await sender.setParameters(p).catch((e) => log("setParameters failed", e.message));
  }
}

// ---------- session ----------
let conn = null, pc = null, recorder = null, recChunks = [], recStart = 0, stopped = false;
let drawTimer = null, statsTimer = null, capTimer = null;
const statsLog = [];
let outFrames = 0, outFirstWall = 0;
let outMeta = { width: 0, height: 0 };

async function tokenProvider(app) {
  const r = await fetch("/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app }) });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return r.text();
}

function onOutputFrame(now, meta) {
  const v = $("out");
  outFrames++;
  if (!outFirstWall) {
    outFirstWall = performance.now();
    mark("firstOutputFrame");
    outMeta = { width: meta.width, height: meta.height };
    log("output size", outMeta);
    if (REC) startRecorder(v.srcObject);
    setTimeout(startPlayback, WARMUP_MS);
  }
  if (meta.width !== outMeta.width || meta.height !== outMeta.height) {
    outMeta = { width: meta.width, height: meta.height };
    log("output size changed", outMeta);
  }
  const e = outEnergy(v, 0, 0, v.videoWidth, v.videoHeight);
  outSeries.push([performance.now(), e, meta.mediaTime]);
  if (!stopped) v.requestVideoFrameCallback(onOutputFrame);
}

function startRecorder(stream) {
  const mime = ["video/webm;codecs=h264", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.start(500);
  recStart = performance.now();
  mark("recorderStart");
}

function startPlayback() {
  if (stopped) return;
  loopIdx = 0;
  src.currentTime = 0;
  src.play();
  loopStarts.push(performance.now());
  mark("playStart");
}
src.addEventListener("ended", () => {
  if (stopped) return;
  if (loopIdx + 1 < LOOPS) {
    loopIdx++;
    src.currentTime = 0;
    src.play();
    loopStarts.push(performance.now());
    log("loop", loopIdx);
  } else {
    mark("playEnd");
    setTimeout(() => stop("done"), TAIL_MS);
  }
});

async function collectStats() {
  if (!pc) return;
  const s = await pc.getStats();
  const row = { t: performance.now() };
  s.forEach((r) => {
    if (r.type === "inbound-rtp" && r.kind === "video")
      Object.assign(row, { inW: r.frameWidth, inH: r.frameHeight, inFps: r.framesPerSecond, inDecoded: r.framesDecoded, inDropped: r.framesDropped, inBytes: r.bytesReceived, inCodec: r.codecId });
    if (r.type === "outbound-rtp" && r.kind === "video")
      Object.assign(row, { outW: r.frameWidth, outH: r.frameHeight, outFps: r.framesPerSecond, outSent: r.framesSent, targetBps: r.targetBitrate, outBytes: r.bytesSent, qLimit: r.qualityLimitationReason, outCodec: r.codecId });
    if (r.type === "codec") row["codec_" + r.id] = r.mimeType;
    if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") Object.assign(row, { rtt: r.currentRoundTripTime, availOutBps: r.availableOutgoingBitrate });
  });
  row.inCodec = row["codec_" + row.inCodec] || row.inCodec;
  row.outCodec = row["codec_" + row.outCodec] || row.outCodec;
  for (const k of Object.keys(row)) if (k.startsWith("codec_")) delete row[k];
  statsLog.push(row);
}

async function start() {
  if (conn) return;
  log("model", ENDPOINT, "clip", CLIP, "loops", LOOPS, "expand", EXPAND);
  src.src = `/media/${CLIP}.mp4`;
  await new Promise((r) => src.addEventListener("loadeddata", r, { once: true }));
  log("clip duration", src.duration.toFixed(3));
  drawTimer = setInterval(drawInput, 1000 / FPS);
  drawInput();
  const stream = inCanvas.captureStream(FPS);
  const reference = await avatarDataUri();
  log("reference data URI bytes", reference.length);

  let initialized = false;
  const pending = [];
  let haveRemote = false;
  const initPeer = async (iceServers) => {
    if (initialized) return;
    initialized = true;
    pc = new RTCPeerConnection({ iceServers: iceServers || [{ urls: "stun:stun.l.google.com:19302" }] });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    preferCodec(pc);
    pc.ontrack = (ev) => {
      mark("ontrack");
      const v = $("out");
      v.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      v.play().catch(() => {});
      v.requestVideoFrameCallback(onOutputFrame);
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate)
        conn.send({ type: "icecandidate", candidate: { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid, sdpMLineIndex: ev.candidate.sdpMLineIndex } });
    };
    pc.onconnectionstatechange = () => {
      log("pc state", pc.connectionState);
      if (pc.connectionState === "connected") mark("pcConnected");
      if (pc.connectionState === "failed") stop("pc failed");
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    conn.send({ type: "offer", sdp: offer.sdp });
    mark("offerSent");
  };

  mark("connectStart");
  if (DRY) {
    const pc2 = new RTCPeerConnection();
    pc = new RTCPeerConnection();
    for (const track of stream.getTracks()) { pc.addTrack(track, stream); }
    preferCodec(pc);
    pc.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc.addIceCandidate(e.candidate);
    pc2.ontrack = (ev) => {
      mark("ontrack");
      const v = $("out");
      v.srcObject = ev.streams[0];
      v.play().catch(() => {});
      v.requestVideoFrameCallback(onOutputFrame);
    };
    pc.onconnectionstatechange = () => pc.connectionState === "connected" && mark("pcConnected");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc.setRemoteDescription({ type: "answer", sdp: mungeAnswer(answer.sdp) });
    await capSender(pc);
    statsTimer = setInterval(collectStats, 1000);
    capTimer = setTimeout(() => stop("max session cap"), MAX_S * 1000);
    return;
  }
  conn = fal.realtime.connect(ENDPOINT, {
    connectionKey: `lucy-${crypto.randomUUID()}`,
    throttleInterval: 0,
    tokenProvider,
    tokenExpirationSeconds: 120,
    onResult: async (m) => {
      try {
        const type = String(m.type || "").toLowerCase();
        if (type !== "icecandidate") log("msg", type || "(no type)", type === "answer" || type === "offer" ? "(sdp)" : JSON.stringify(m).slice(0, 400));
        if (type === "ready") {
          mark("ready");
          const ice = m.iceServers || m.ice_servers || m.iceservers;
          if (ice) await initPeer(ice);
          else setTimeout(() => initPeer().catch((e) => log("initPeer error", e.message)), 1000);
        } else if (type === "iceservers") {
          await initPeer(m.iceServers || m.ice_servers || m.iceservers);
        } else if (type === "answer" && pc && !haveRemote) {
          log("answer sdp lines", m.sdp.split(/\r?\n/).filter((l) => /^(b=|a=fmtp|a=rtpmap|m=video|a=extmap.*transport-wide|a=rtcp-fb:\S+ (goog-remb|transport-cc))/.test(l)).slice(0, 40));
          await pc.setRemoteDescription({ type: "answer", sdp: mungeAnswer(m.sdp) });
          await capSender(pc);
          haveRemote = true;
          mark("answer");
          for (const c of pending.splice(0)) await pc.addIceCandidate(c);
        } else if (type === "icecandidate" && m.candidate) {
          if (!pc || !haveRemote) pending.push(m.candidate);
          else await pc.addIceCandidate(m.candidate);
        } else if (type === "error") {
          stop("server error");
        }
      } catch (e) {
        log("handler error", e.message);
      }
    },
    onError: (e) => {
      log("fal error", e && e.message, e && e.status, e && e.body ? JSON.stringify(e.body).slice(0, 400) : "");
      stop("fal error");
    },
    onClose: (e) => {
      log("ws closed", e.code, e.reason);
      stop("ws closed");
    },
  });
  conn.send({ prompt: PROMPT, reference_image_url: reference, enable_prompt_expansion: EXPAND });
  mark("inputSent");
  statsTimer = setInterval(collectStats, 1000);
  capTimer = setTimeout(() => stop("max session cap"), MAX_S * 1000);
}

// ---------- analysis ----------
function resample(series, from, to, step) {
  const out = [];
  let j = 0;
  for (let t = from; t <= to; t += step) {
    while (j + 1 < series.length && series[j + 1][0] <= t) j++;
    out.push(series.length ? series[j][1] : 0);
  }
  return out;
}
function norm(a) {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) || 1;
  return a.map((x) => (x - m) / sd);
}
function estimateLag() {
  if (!events.playStart || outSeries.length < 10) return null;
  const step = 20;
  const from = events.playStart - 500;
  const to = (events.playEnd || performance.now()) + 0;
  const a = norm(resample(inSeries, from, to, step));
  const b = norm(resample(outSeries, from, to + 3000, step));
  let best = { lagMs: 0, r: -Infinity };
  for (let k = 0; k <= 3000 / step; k++) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * (b[i + k] ?? 0);
    const r = s / a.length;
    if (r > best.r) best = { lagMs: k * step, r: +r.toFixed(3) };
  }
  return best;
}
function onsetLag() {
  // first big motion after playStart in input vs output (threshold = 40% of the input's max energy)
  if (!events.playStart) return null;
  const inAfter = inSeries.filter((x) => x[0] >= events.playStart);
  const outAfter = outSeries.filter((x) => x[0] >= events.playStart);
  if (!inAfter.length || !outAfter.length) return null;
  const thrIn = 0.4 * Math.max(...inAfter.map((x) => x[1]));
  const thrOut = 0.4 * Math.max(...outAfter.map((x) => x[1]));
  const a = inAfter.find((x) => x[1] >= thrIn);
  const b = outAfter.find((x) => x[1] >= thrOut && (!a || x[0] >= a[0]));
  return a && b ? Math.round(b[0] - a[0]) : null;
}

async function stop(reason) {
  if (stopped) return;
  stopped = true;
  mark("stop");
  log("stop:", reason);
  clearTimeout(capTimer);
  clearInterval(statsTimer);
  await collectStats().catch(() => {});
  src.pause();
  clearInterval(drawTimer);
  try { conn && conn.close(); } catch {}
  try { pc && pc.close(); } catch {}
  let blob = null;
  if (recorder && recorder.state !== "inactive") {
    await new Promise((r) => { recorder.onstop = r; recorder.stop(); });
    blob = new Blob(recChunks, { type: recorder.mimeType });
  }
  const rel = (n) => (events[n] !== undefined ? Math.round(events[n] - events.connectStart) : null);
  const steady = outSeries.filter((x) => events.playStart && x[0] >= events.playStart && x[0] <= (events.playEnd || Infinity));
  const outFps = steady.length > 1 ? (steady.length - 1) / ((steady[steady.length - 1][0] - steady[0][0]) / 1000) : null;
  const statsFps = statsLog.filter((r) => r.inFps).map((r) => r.inFps);
  const summary = {
    model: ENDPOINT, clip: CLIP, loops: LOOPS, reference: REF, prompt: PROMPT, enable_prompt_expansion: EXPAND, reason,
    msFromConnect: { ready: rel("ready"), offerSent: rel("offerSent"), answer: rel("answer"), pcConnected: rel("pcConnected"), ontrack: rel("ontrack"), firstOutputFrame: rel("firstOutputFrame"), playStart: rel("playStart"), playEnd: rel("playEnd"), stop: rel("stop") },
    streamedSeconds: events.ready ? +((events.stop - events.connectStart) / 1000).toFixed(2) : 0,
    output: { ...outMeta, renderedFpsDuringPlayback: outFps && +outFps.toFixed(1), rtpFpsMedian: statsFps.length ? statsFps.sort((x, y) => x - y)[statsFps.length >> 1] : null, framesRendered: outFrames },
    lag: { xcorr: estimateLag(), onsetMs: onsetLag() },
    recording: { recStartMsFromConnect: rel("recorderStart"), loopStartsMsFromRec: loopStarts.map((t) => Math.round(t - recStart)), mime: recorder && recorder.mimeType, bytes: blob ? blob.size : 0 },
  };
  log("summary", summary);
  const tag = `${DRY ? "dry" : MODEL}-${CLIP}${REF === "main" ? "" : "-ref-" + REF}`;
  const save = (name, body) => fetch(`/save?name=${name}`, { method: "POST", body }).catch(() => {});
  if (blob) {
    await save(`${tag}.webm`, blob);
    const a = $("dl");
    a.href = URL.createObjectURL(blob);
    a.download = `${tag}.webm`;
    a.hidden = false;
  }
  await save(`${tag}.json`, JSON.stringify({ summary, events, stats: statsLog, inSeries, outSeries, log: logLines }, null, 1));
  window.__done = summary;
}

$("start").onclick = () => start().catch((e) => { log("start error", e.message); stop("start error"); });
$("stop").onclick = () => stop("user");
window.__start = () => $("start").onclick();
if (q.get("auto") === "1") window.__start();
