// Gapless playlist playback with two expo-video players: while one plays clip i, the other has clip
// i+1 loaded and paused; on playToEnd we start the other and swap. All clips start and end in the
// same neutral pose, so the cut is invisible. The playlist may grow while playing (live speech).
import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useVideoPlayer, VideoView, type VideoPlayer } from "expo-video";
import type { PlaylistItem } from "@signlayer/core";

interface Props {
  playlist: PlaylistItem[];
  /** Change to restart from the first clip (Replay). */
  runKey: number;
  /** -1 = not started, i = playing clip i, playlist.length = caught up / finished. */
  onIndex: (i: number) => void;
}

const setup = (p: VideoPlayer) => { p.muted = true; p.loop = false; };

export function PlaylistPlayer({ playlist, runKey, onIndex }: Props) {
  const a = useVideoPlayer(null, setup);
  const b = useVideoPlayer(null, setup);
  const players = [a, b] as const;
  const [active, setActive] = useState(0);
  const st = useRef({ active: 0, cur: -1, loaded: [-1, -1] as number[], list: playlist, run: runKey });
  st.current.list = playlist;

  const load = async (slot: number, i: number) => {
    const item = st.current.list[i];
    const p = players[slot]!;
    if (!item) return;
    st.current.loaded[slot] = i;
    await p.replaceAsync({ uri: item.url });
    if (st.current.loaded[slot] !== i) return;
    if (!(st.current.cur === i && st.current.active === slot)) { p.pause(); p.currentTime = 0; }
  };

  const start = async (slot: number, i: number) => {
    const S = st.current;
    S.cur = i; S.active = slot; setActive(slot); onIndex(i);
    const p = players[slot]!;
    if (S.loaded[slot] !== i) await load(slot, i);
    p.currentTime = 0;
    p.play();
    if (S.list[i + 1]) load(1 - slot, i + 1);
  };

  const advance = () => {
    const S = st.current, next = S.cur + 1;
    if (next < S.list.length) start(1 - S.active, next);
    else { S.cur = S.list.length; onIndex(S.cur); }
  };

  useEffect(() => {
    const subs = players.map((p, slot) => p.addListener("playToEnd", () => { if (slot === st.current.active) advance(); }));
    return () => subs.forEach((s) => s.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b]);

  // New clips arrived: start if idle, resume if we had caught up, else make sure the next clip is preloaded.
  useEffect(() => {
    const S = st.current;
    if (!playlist.length) return;
    if (S.cur === -1) { start(S.active, 0); return; }
    if (S.cur >= playlist.length) return;
    if (S.loaded[S.active] !== S.cur) { start(1 - S.active, S.cur); return; }
    if (playlist[S.cur + 1] && S.loaded[1 - S.active] !== S.cur + 1) load(1 - S.active, S.cur + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist.length]);

  // Replay.
  useEffect(() => {
    if (st.current.run === runKey) return;
    st.current.run = runKey;
    players.forEach((p) => p.pause());
    st.current.loaded = [-1, -1];
    st.current.cur = -1;
    if (playlist.length) start(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  const surface = Platform.OS === "android" ? { surfaceType: "textureView" as const } : {};
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {players.map((p, i) => (
        <VideoView key={i} player={p} nativeControls={false} contentFit="cover" allowsPictureInPicture={false} {...surface}
          style={[StyleSheet.absoluteFill, { opacity: i === active ? 1 : 0 }]} />
      ))}
    </View>
  );
}
