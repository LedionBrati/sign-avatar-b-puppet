import { useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Home } from "./src/screens/Home";
import { Live } from "./src/screens/Live";
import { Settings } from "./src/screens/Settings";
import { Sign } from "./src/screens/Sign";
import { useServerUrl } from "./src/lib/settings";

type Screen = { name: "home" } | { name: "live"; typed: boolean; key: number } | { name: "sign" };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { url, setUrl, loaded } = useServerUrl();
  // No server address yet (nothing saved or detected on a phone): ask for it before opening a screen that needs it.
  const needUrl = loaded && !url;
  const go = (typed: boolean) => (needUrl ? setSettingsOpen(true) : setScreen({ name: "live", typed, key: Date.now() }));

  return (
    <SafeAreaProvider style={{ backgroundColor: "#1f3fd6" }}>
      <StatusBar style="light" />
      {screen.name === "home" ? (
        <Home onListen={() => go(false)} onType={() => go(true)} onSign={() => (needUrl ? setSettingsOpen(true) : setScreen({ name: "sign" }))} onSettings={() => setSettingsOpen(true)} />
      ) : screen.name === "sign" ? (
        <Sign key={url} serverUrl={url} onExit={() => setScreen({ name: "home" })} onSettings={() => setSettingsOpen(true)} />
      ) : (
        <Live key={screen.key} serverUrl={url} typed={screen.typed} onExit={() => setScreen({ name: "home" })} onSettings={() => setSettingsOpen(true)} />
      )}
      <Settings visible={settingsOpen} url={url} onSave={setUrl} onClose={() => setSettingsOpen(false)} />
    </SafeAreaProvider>
  );
}
