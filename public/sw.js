// Minimal service worker: caches the app shell so it opens quickly and
// installs to the home screen. Data always comes live from the database.
// All paths are relative to the worker's scope, so it works at the site root
// and under a GitHub Pages sub-path (/<repo>/).
const CACHE = 'tl-ops-v3';
const scoped = (p) => new URL(p, self.registration.scope).href;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'index.html', 'manifest.webmanifest', 'icon.svg'].map(scoped))));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // never cache API calls
  if (e.request.mode === 'navigate') {
    // Always ask the server (GitHub Pages lets browsers reuse the page for
    // 10 minutes, which would keep serving the previous version after a deploy)
    e.respondWith(fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .catch(() => caches.match(scoped('index.html'))));
    return;
  }
  if (url.href.startsWith(scoped('assets/'))) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })));
  }
});
