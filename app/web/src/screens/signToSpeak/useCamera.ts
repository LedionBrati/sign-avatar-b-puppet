// The front camera + MediaPipe Holistic: starts both on mount, then runs one detection per presented video frame,
// draws the landmarks on the overlay canvas and hands every frame to onFrame (the segmenter).
import { useCallback, useEffect, useRef, useState } from "react";
import type { HolisticFrame } from "@flux/core";
import { createTracker, drawOverlay, type Tracker } from "../../lib/holistic";
import { debugStats } from "../../lib/debug";

export type Cam = "starting" | "ready" | "denied" | "nocam" | "error";
export type Track = "loading" | "ready" | "error";

export function useCamera({ onFrame, onError }: {
  onFrame: (f: HolisticFrame, t: number) => void;
  /** Hand tracking didn't load (a banner). */
  onError: (msg: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tracker = useRef<Tracker | null>(null);
  const alive = useRef(true);
  const fpsRef = useRef(30);
  const cb = useRef({ onFrame, onError });
  cb.current = { onFrame, onError };

  const [cam, setCam] = useState<Cam>("starting");
  const [camMsg, setCamMsg] = useState("");
  const [track, setTrack] = useState<Track>("loading");
  const [fps, setFps] = useState(0);
  const [hands, setHands] = useState(false);

  const startCam = useCallback(async () => {
    setCam("starting");
    setCamMsg("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } });
      if (!alive.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});
      setCam("ready");
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === "NotAllowedError" || name === "SecurityError") { setCam("denied"); setCamMsg("Camera access is blocked. Allow it from the icon in the address bar (or site settings), then tap Retry."); }
      else if (name === "NotFoundError" || name === "OverconstrainedError") { setCam("nocam"); setCamMsg("No camera found. Plug one in, or open this on your phone."); }
      else { setCam("error"); setCamMsg(`The camera didn't start (${(e as Error).message || name}).`); }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void startCam();
    createTracker().then((t) => {
      if (!alive.current) { t.close(); return; }
      tracker.current = t;
      debugStats({ delegate: t.delegate });
      setTrack("ready");
    }).catch((e) => { if (alive.current) { setTrack("error"); cb.current.onError(`Hand tracking didn't load (${(e as Error).message}). Check the connection and reload.`); } });
    return () => {
      alive.current = false;
      const s = video.current?.srcObject as MediaStream | null;
      s?.getTracks().forEach((t) => t.stop());
      tracker.current?.close();
      tracker.current = null;
    };
  }, [startCam]);

  // ── Per-frame loop: detect, draw, segment, fps ──
  useEffect(() => {
    if (cam !== "ready" || track !== "ready") return;
    const v = video.current!, c = canvas.current!, ctx = c.getContext("2d")!;
    let stop = false, handle = 0, lastT = -1, n = 0, dms = 0, win = performance.now(), sawHands = false;
    const rvfc = "requestVideoFrameCallback" in v;
    const next = () => { handle = rvfc ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(() => tick()); };
    const tick = () => {
      if (stop || !alive.current) return;
      const t = tracker.current;
      if (t && v.readyState >= 2 && v.currentTime !== lastT) {
        lastT = v.currentTime;
        if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
        const now = performance.now();
        const f = t.detect(v, now);
        dms += performance.now() - now;
        drawOverlay(ctx, f, t.connections);
        cb.current.onFrame(f, performance.now());
        const h = Boolean(f.leftHand?.length || f.rightHand?.length);
        if (h !== sawHands) { sawHands = h; setHands(h); }
        n++;
        if (now - win >= 1000) { const r = (n * 1000) / (now - win); setFps(r); fpsRef.current = r; debugStats({ fps: +r.toFixed(1), detectMs: Math.round(dms / n) }); n = 0; dms = 0; win = now; }
      }
      next();
    };
    next();
    return () => { stop = true; if (rvfc) v.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle); };
  }, [cam, track]);

  return {
    video, canvas, cam, camMsg, track, fps, hands, startCam,
    /** Frames per second measured over the last second (sent with every recognize call). */
    fpsRef,
    /** "GPU" / "CPU" once hand tracking is loaded. */
    delegate: () => tracker.current?.delegate,
    ready: cam === "ready" && track === "ready",
  };
}
