// BIG QUAMS MEDIA® Service Worker v3
// Updated: 2026 — covers all new pages, stale-while-revalidate for JSON

const CACHE_NAME = 'bqm-v3';
const STATIC_CACHE = 'bqm-static-v3';
const JSON_CACHE   = 'bqm-json-v3';

// Core shell — always cached
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/newsroom.html',
  '/elibrary.html',
  '/dyk.html',
  '/spotlight.html',
  '/results.html',
  '/postutme-calculator.html',
  '/cbt.html',
  '/scholarship.html',
  '/subject-combo.html',
  '/community.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&family=Roboto:wght@300;400;500;700&display=swap',
];

// JSON data files — stale-while-revalidate
const JSON_FILES = [
  '/news.json',
  '/books.json',
  '/dyk.json',
  '/spotlight.json',
  '/reviews.json',
  '/qa.json',
  '/calendar.json',
];

// ── INSTALL ──
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
      );
    })
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== JSON_CACHE)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin (except fonts/Firebase)
  if (request.method !== 'GET') return;
  if (url.origin !== location.origin &&
      !url.hostname.includes('fonts.googleapis.com') &&
      !url.hostname.includes('fonts.gstatic.com') &&
      !url.hostname.includes('i.imgur.com')) return;

  // JSON files: stale-while-revalidate (always fresh data when online)
  if (JSON_FILES.some(f => url.pathname === f || url.pathname.startsWith(f.replace('.json','')))) {
    event.respondWith(staleWhileRevalidate(request, JSON_CACHE));
    return;
  }

  // Firebase & external APIs: network only
  if (url.hostname.includes('firebaseapp.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebasestorage.app') ||
      url.hostname.includes('gstatic.com') && url.pathname.includes('firebasejs')) {
    return; // let browser handle
  }

  // Static assets: cache-first
  event.respondWith(cacheFirst(request, STATIC_CACHE));
});

// ── STRATEGIES ──
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — please check your connection.', {
      status: 503, headers: { 'Content-Type': 'text/plain' }
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || await networkFetch || new Response('[]', {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', event => {
  let data = { title: 'Big Quams Media®', body: 'You have a new update!' };
  try { data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'https://i.imgur.com/lYJXUyY.jpeg',
      badge: 'https://i.imgur.com/lYJXUyY.jpeg',
      tag: data.tag || 'bqm-update',
      data: { url: data.url || '/' },
      actions: [
        { action: 'open', title: 'View Now' },
        { action: 'dismiss', title: 'Dismiss' }
      ]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── MESSAGE HANDLER (for welcome notification from page) ──
self.addEventListener('message', event => {
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(event.data.title || 'Big Quams Media®', {
      body: event.data.body || 'You have a new update!',
      icon: 'https://i.imgur.com/lYJXUyY.jpeg',
      badge: 'https://i.imgur.com/lYJXUyY.jpeg',
      tag: 'bqm-welcome',
      data: { url: event.data.url || '/' }
    });
  }
  // Skip waiting — force update
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
    
