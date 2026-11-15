import { useCallback, useState } from "react";
import { Home } from "./screens/Home";
import { Live, type LiveStart } from "./screens/Live";
import { Settings } from "./components/Settings";
import { speechSupported } from "./lib/speech";

export function App() {
  const [live, setLive] = useState<{ start: LiveStart; key: number } | null>(null);
  const [settings, setSettings] = useState(false);
  const canListen = speechSupported();
  const go = useCallback((start: LiveStart) => {
    if (start.kind === "typed" && !start.text.trim()) { setLive(null); return; }
    setLive({ start, key: Date.now() });
  }, []);
  const home = useCallback(() => setLive(null), []);
  return (
    <div className="app">
      <main className="device" aria-live="polite">
        {live ? (
          <Live key={live.key} start={live.start} onHome={home} onRestart={go} />
        ) : (
          <Home canListen={canListen} onListen={() => go({ kind: "mic" })} onType={(text) => go({ kind: "typed", text })} onSettings={() => setSettings(true)} />
        )}
        {settings ? <Settings onClose={() => setSettings(false)} /> : null}
      </main>
    </div>
  );
}
