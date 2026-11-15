// Tiny hash router: "#/" home, "#/sign" sign -> speak, "#/sign?embed=1" the same screen for the phone app's WebView.
import { useEffect, useState } from "react";
import { transition } from "./motion";

export interface Route { path: string; params: URLSearchParams }

export function parseHash(hash = location.hash): Route {
  const h = hash.replace(/^#/, "") || "/";
  const [p, q = ""] = h.split("?");
  return { path: p || "/", params: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [r, setR] = useState(parseHash);
  useEffect(() => {
    let last = location.hash;
    // navigate() fires a synthetic hashchange and the browser fires its own: only the first one animates.
    const on = () => { if (location.hash === last) return; last = location.hash; transition(() => setR(parseHash())); };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const navigate = (path: string) => { location.hash = path === "/" ? "" : `#${path}`; if (path === "/") history.replaceState(null, "", location.pathname + location.search); dispatchEvent(new HashChangeEvent("hashchange")); };
