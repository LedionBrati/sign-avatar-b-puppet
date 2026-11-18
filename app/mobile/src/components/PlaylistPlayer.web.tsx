// Web build of the gapless playlist player (same contract as PlaylistPlayer.tsx), using two plain
// <video> elements. expo-video's web VideoView re-applies `src` on every React render, which reloads
// a clip we already preloaded and stalls the swap, so the browser preview drives the elements itself.
import { useEffect, useRef, useState } from "react";
import type { PlaylistItem } from "@flux/core";

interface Props {
  playlist: PlaylistItem[];
  runKey: number;
  onIndex: (i: number) => void;
}

const fill = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" } as const;

export function PlaylistPlayer({ playlist, runKey, onIndex }: Props) {
  const refs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [active, setActive] = useState(0);
  const st = useRef({ active: 0, cur: -1, loaded: [-1, -1] as number[], list: playlist, run: runKey });
  st.current.list = playlist;
  const v = (slot: number) => refs[slot]!.current!;

  const load = (slot: number, i: number) => {
    const item = st.current.list[i];
    if (!item) return;
    st.current.loaded[slot] = i;
    const el = v(slot);
    el.src = item.url;
    el.load();
  };

  const start = (slot: number, i: number) => {
    const S = st.current;
    S.cur = i; S.active = slot; setActive(slot); onIndex(i);
    if (S.loaded[slot] !== i) load(slot, i);
    const el = v(slot);
    el.currentTime = 0;
    el.play().catch(() => {});
    if (S.list[i + 1]) load(1 - slot, i + 1);
  };

  const advance = (slot: number) => {
    const S = st.current;
    if (slot !== S.active) return;
    const next = S.cur + 1;
    if (next < S.list.length) start(1 - S.active, next);
    else { S.cur = S.list.length; onIndex(S.cur); }
  };

  useEffect(() => {
    const S = st.current;
    if (!playlist.length) return;
    if (S.cur === -1) { start(S.active, 0); return; }
    if (S.cur >= playlist.length) return;
    if (S.loaded[S.active] !== S.cur) { start(1 - S.active, S.cur); return; }
    if (playlist[S.cur + 1] && S.loaded[1 - S.active] !== S.cur + 1) load(1 - S.active, S.cur + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist.length]);

  useEffect(() => {
    if (st.current.run === runKey) return;
    st.current.run = runKey;
    [0, 1].forEach((s) => v(s).pause());
    st.current.loaded = [-1, -1];
    st.current.cur = -1;
    if (playlist.length) start(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {[0, 1].map((slot) => (
        <video key={slot} ref={refs[slot]} muted playsInline preload="auto" onEnded={() => advance(slot)}
          style={{ ...fill, opacity: slot === active ? 1 : 0 }} aria-label="Signer" />
      ))}
    </div>
  );
}
