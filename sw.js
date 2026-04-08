// ═══════════════════════════════════════════════
//  BIG QUAMS MEDIA® — Cache Service Worker
//  Handles offline caching only.
//  Push notifications handled by firebase-messaging-sw.js
// ═══════════════════════════════════════════════

const CACHE = 'bqm-v5';
const PAGES = ['/', '/index.html', '/newsroom.html', '/elibrary.html', '/dyk.html', '/spotlight.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PAGES).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // JSON: network first (always fresh), cache fallback
  if (url.pathname.endsWith('.json')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => { const c = res.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); return res; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // HTML/assets: cache first, update in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const net = fetch(e.request).then(res => {
        const c = res.clone();
        caches.open(CACHE).then(ca => ca.put(e.request, c));
        return res;
      });
      return cached || net;
    }).catch(() => caches.match('/index.html'))
  );
});
