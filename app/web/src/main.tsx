import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./lib/prefs";
import { ARTIFACT } from "./config";
import "./styles.css";

applyTheme();

createRoot(document.getElementById("root")!).render(<App />);

// App shell offline cache (never the API or clips). Production only, so dev reloads stay fresh. Never in the artifact build.
if (import.meta.env.PROD && !ARTIFACT && "serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {}));
}
