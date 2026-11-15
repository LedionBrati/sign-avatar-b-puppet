import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./lib/prefs";
import "./styles.css";

applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);

createRoot(document.getElementById("root")!).render(<App />);

// App shell offline cache (never the API or clips). Production only, so dev reloads stay fresh.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {}));
}
