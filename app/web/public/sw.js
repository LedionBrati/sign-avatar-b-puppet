// Flux service worker: caches the app shell so the app opens offline / instantly.
// Never caches the sign API or clips (they live on the local server and change as signs are added).
// Paths are relative to the worker, so the app works at / (Vite) and at /app/ (served by app/server for the phone WebView).
const CACHE = "flux-shell-v3";
const BASE = new URL("./", self.location.href).pathname;
const SHELL = ["", "index.html", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"].map((p) => BASE + p);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/clips/")) return;
  if (req.mode === "navigate") {
    // Network first for the page, cached shell when offline.
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(BASE + "index.html", copy)); return r; })
      .catch(() => caches.match(BASE + "index.html")));
    return;
  }
  // Hashed build assets: cache first.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok && (url.pathname.startsWith(BASE + "assets/") || SHELL.includes(url.pathname))) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return r;
  })));
});
