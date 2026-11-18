// Server URL: persisted with AsyncStorage. Suggests the laptop's LAN IP when it can be detected
// (the Expo dev server's host, or the page's host on web) with the API's default port. Nothing saved and nothing
// detected: localhost on web, empty on a phone (the app opens Settings so the user enters the dev machine's address).
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { DEFAULT_PORT } from "@flux/core";

const KEY = "flux.serverUrl";
export const PLACEHOLDER = `http://192.168.x.x:${DEFAULT_PORT}`;
/** Used only when nothing is saved and nothing can be detected. */
export const FALLBACK_URL = Platform.OS === "web" ? `http://localhost:${DEFAULT_PORT}` : "";

/** Best guess for the server: same machine that serves the JS bundle (Metro) or the web page. */
export function detectServerUrl(): string | null {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const q = new URLSearchParams(window.location.search).get("server");
    if (q) return q;
    const h = window.location.hostname;
    return h ? `http://${h}:${DEFAULT_PORT}` : null;
  }
  const hostUri = Constants.expoConfig?.hostUri ?? (Constants as unknown as { manifest2?: { extra?: { expoClient?: { hostUri?: string } } } }).manifest2?.extra?.expoClient?.hostUri;
  const host = hostUri?.split(":")[0];
  return host ? `http://${host}:${DEFAULT_PORT}` : null;
}

export const normalizeUrl = (u: string) => {
  const t = u.trim().replace(/\/+$/, "");
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
};

export function useServerUrl() {
  const [url, setUrlState] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    (async () => {
      let saved: string | null = null;
      try { saved = await AsyncStorage.getItem(KEY); } catch {}
      const q = Platform.OS === "web" && typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("server") : null;
      setUrlState(q || saved || detectServerUrl() || FALLBACK_URL);
      setLoaded(true);
    })();
  }, []);
  const setUrl = useCallback(async (u: string) => {
    const n = normalizeUrl(u);
    setUrlState(n);
    try { await AsyncStorage.setItem(KEY, n); } catch {}
  }, []);
  return { url, setUrl, loaded };
}
