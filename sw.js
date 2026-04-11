// BIG QUAMS MEDIA® Service Worker v4 — Firebase Cloud Messaging
// Handles: offline caching (stale-while-revalidate) + FCM push notifications

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// ── FIREBASE CONFIG ──
firebase.initializeApp({
  apiKey:            'AIzaSyCRrp0cGK-hlBy8Ez8blesCsWn3FP7I-lQ',
  authDomain:        'big-quams-media.firebaseapp.com',
  projectId:         'big-quams-media',
  storageBucket:     'big-quams-media.firebasestorage.app',
  messagingSenderId: '383186323859',
  appId:             '1:383186323859:web:826d6b9977cfa947730066'
});

const messaging = firebase.messaging();

// ── CACHE CONFIG ──
const STATIC_CACHE = 'bqm-static-v4';
const JSON_CACHE   = 'bqm-json-v4';

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
];

const JSON_FILES = [
  '/news.json',
  '/books.json',
  '/dyk.json',
  '/spotlight.json',
  '/reviews.json',
  '/qa.json',
  '/calendar.json',
  '/scholarships.json',
];

// ── INSTALL ──
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache =>
      Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url).catch(() => {})))
    )
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

  if (request.method !== 'GET') return;

  // Skip Firebase & external APIs — never cache these
  if (url.hostname.includes('firebaseapp.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebasestorage.app') ||
      url.hostname.includes('gstatic.com')) return;

  // Skip cross-origin except fonts & imgur
  if (url.origin !== location.origin &&
      !url.hostname.includes('fonts.googleapis.com') &&
      !url.hostname.includes('fonts.gstatic.com') &&
      !url.hostname.includes('i.imgur.com')) return;

  // JSON: stale-while-revalidate (always fast, always fresh when online)
  if (JSON_FILES.some(f => url.pathname === f || url.pathname.startsWith(f.replace('.json', '')))) {
    event.respondWith(staleWhileRevalidate(request, JSON_CACHE));
    return;
  }

  // Static HTML/CSS/JS: cache-first
  event.respondWith(cacheFirst(request, STATIC_CACHE));
});

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
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || await networkFetch || new Response('[]', {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── FCM: BACKGROUND MESSAGE HANDLER ──
// Fires when the app is closed, in background, or device reconnects to data
messaging.onBackgroundMessage(payload => {
  const data = payload.data || {};
  const notif = payload.notification || {};

  const title = data.title || notif.title || 'Big Quams Media®';
  const body  = data.body  || notif.body  || 'You have a new update!';
  const icon  = data.icon  || notif.icon  || 'https://i.imgur.com/lYJXUyY.jpeg';
  const url   = data.url   || 'https://big-quams-educational-hub.github.io/';
  const tag   = data.tag   || 'bqm-update';
  const image = data.image || notif.image || undefined;

  return self.registration.showNotification(title, {
    body,
    icon,
    badge:    'https://i.imgur.com/lYJXUyY.jpeg',
    image,
    tag,
    renotify: true,
    data:     { url },
    actions:  [
      { action: 'open',    title: '👀 View Now' },
      { action: 'dismiss', title: 'Dismiss'     }
    ],
    vibrate:  [200, 100, 200],
  });
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url ||
                    'https://big-quams-educational-hub.github.io/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('big-quams-educational-hub') && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// ── MESSAGE FROM PAGE ──
self.addEventListener('message', event => {
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(
      event.data.title || 'Big Quams Media®',
      {
        body:  event.data.body || 'You have a new update!',
        icon:  'https://i.imgur.com/lYJXUyY.jpeg',
        badge: 'https://i.imgur.com/lYJXUyY.jpeg',
        tag:   'bqm-manual',
        data:  { url: event.data.url || '/' }
      }
    );
  }
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
