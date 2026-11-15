import { useCallback, useState } from "react";
import { Home } from "./screens/Home";
import { Live, type LiveStart } from "./screens/Live";
import { SignToSpeak } from "./screens/SignToSpeak";
import { navigate, useRoute } from "./lib/route";
import { transition } from "./lib/motion";
import { Settings } from "./components/Settings";
import { speechSupported } from "./lib/speech";
import { captureSupported } from "./lib/capture";

export function App() {
  const [live, setLive] = useState<{ start: LiveStart; key: number } | null>(null);
  const [settings, setSettings] = useState(false);
  const canListen = speechSupported() || captureSupported();
  const go = useCallback((start: LiveStart) => {
    if (start.kind === "typed" && !start.text.trim()) { transition(() => setLive(null)); return; }
    transition(() => setLive({ start, key: Date.now() }));
  }, []);
  const home = useCallback(() => transition(() => setLive(null)), []);
  const route = useRoute();
  const embed = route.params.get("embed") === "1";
  if (route.path === "/sign") {
    return (
      <div className={`app${embed ? " embed" : ""}`}>
        <main className="device">
          <SignToSpeak embed={embed} onHome={() => navigate("/")} />
          {settings ? <Settings onClose={() => setSettings(false)} /> : null}
        </main>
      </div>
    );
  }
  return (
    <div className="app">
      <main className="device">
        {live ? (
          <Live key={live.key} start={live.start} onHome={home} onRestart={go} />
        ) : (
          <Home canListen={canListen} onListen={() => go({ kind: "mic" })} onType={(text) => go({ kind: "typed", text })} onSettings={() => setSettings(true)} onSign={() => navigate("/sign")} />
        )}
        {settings ? <Settings onClose={() => setSettings(false)} /> : null}
      </main>
    </div>
  );
}
