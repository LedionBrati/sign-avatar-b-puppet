// Web export: same contract as SignFrame.tsx with a plain <iframe>. The page posts to window.parent,
// so only messages whose source is this iframe are taken. The browser shows its own camera prompt
// (allow="camera"); the iframe's origin must be https:// or localhost for getUserMedia.
import { useEffect, useRef } from "react";
import { parseBridge, type BridgeMsg, type FrameError } from "../lib/bridge";
import { colors } from "../theme";

interface Props {
  url: string;
  onMessage: (m: BridgeMsg) => void;
  onError: (e: FrameError) => void;
  onReady: () => void;
}

export function SignFrame({ url, onMessage, onReady }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);
  const cb = useRef(onMessage);
  cb.current = onMessage;
  useEffect(() => {
    const h = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const m = parseBridge(e.data);
      if (m) cb.current(m);
    };
    window.addEventListener("message", h);
    return () => window.removeEventListener("message", h);
  }, []);
  return (
    <iframe
      ref={ref}
      src={url}
      title="Signing camera"
      allow="camera; microphone; autoplay; fullscreen"
      onLoad={onReady}
      data-testid="sign-frame"
      style={{ border: 0, width: "100%", height: "100%", display: "block", background: colors.bg }}
    />
  );
}
