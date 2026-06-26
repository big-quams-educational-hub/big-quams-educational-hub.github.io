// BIG QUAMS MEDIA® Service Worker v7 — Firebase Cloud Messaging
// Handles: offline caching + FCM push notifications
// Data is served from Firebase — no JSON files cached

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
const CACHE_NAME = 'bqm-static-v8';

const BQM_DOMAIN = 'https://bigquamsmedia.com.ng';
const BQM_ICON   = 'https://bigquamsmedia.com.ng/file_000000000370724698997662ddbee6b5.png';

// Only cache static shell assets — all data comes from Firebase
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/explore.html',
  '/newsroom.html',
  '/elibrary.html',
  '/dyk.html',
  '/spotlight.html',
  '/results.html',
  '/postutme-calculator.html',
  '/postutme-prep.html',
  '/cbt.html',
  '/scholarship.html',
  '/subject-combo.html',
  '/community.html',
  '/gpa-calculator.html',
  '/student-loan.html',
  '/manifest.json',
];

// ── INSTALL ──
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url).catch(() => {})))
    )
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // Never intercept Firebase, Google APIs, or any external service
  if (url.hostname.includes('firebaseapp.com')      ||
      url.hostname.includes('googleapis.com')        ||
      url.hostname.includes('firebasestorage.app')   ||
      url.hostname.includes('firebaseio.com')        ||
      url.hostname.includes('gstatic.com')           ||
      url.hostname.includes('firebase.com')) return;

  // Skip cross-origin except fonts
  if (url.origin !== location.origin &&
      !url.hostname.includes('fonts.googleapis.com') &&
      !url.hostname.includes('fonts.gstatic.com')) return;

  // HTML pages: network-first (always fresh, fallback to cache if offline)
  if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname === '') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Static assets (CSS, JS, images, fonts): cache-first
  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — please check your connection.', {
      status: 503, headers: { 'Content-Type': 'text/plain' }
    });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('<h1>You are offline</h1><p>Please check your connection and refresh.</p>', {
      status: 503, headers: { 'Content-Type': 'text/html' }
    });
  }
}

// ── FCM: BACKGROUND MESSAGE HANDLER ──
// Fires when browser is closed, in background, or device reconnects to data
messaging.onBackgroundMessage(payload => {
  const data  = payload.data || {};
  const notif = payload.notification || {};

  const title = data.title || notif.title || 'Big Quams Media®';
  const body  = data.body  || notif.body  || 'You have a new update!';
  const icon  = data.icon  || notif.icon  || BQM_ICON;
  const url   = data.url   || BQM_DOMAIN + '/';
  const tag   = data.tag   || 'bqm-update';
  const image = data.image || notif.image || undefined;

  return self.registration.showNotification(title, {
    body,
    icon,
    badge:    BQM_ICON,
    image,
    tag,
    renotify: true,
    data:     { url },
    actions:  [
      { action: 'open',    title: '👀 View Now' },
      { action: 'dismiss', title: 'Dismiss'     }
    ],
    vibrate: [200, 100, 200],
  });
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || BQM_DOMAIN + '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('bigquamsmedia.com.ng') && 'focus' in client) {
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
        icon:  BQM_ICON,
        badge: BQM_ICON,
        tag:   'bqm-manual',
        data:  { url: event.data.url || BQM_DOMAIN + '/' }
      }
    );
  }

  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();

  if (event.data?.type === 'BROADCAST_NOTIFICATION') {
    const { title, body, icon, url, tag } = event.data;
    self.registration.showNotification(title || 'Big Quams Media®', {
      body:     body  || 'You have a new update!',
      icon:     icon  || BQM_ICON,
      badge:    BQM_ICON,
      tag:      tag   || 'bqm-broadcast',
      renotify: true,
      data:     { url: url || BQM_DOMAIN + '/' },
      actions:  [
        { action: 'open',    title: '👀 View Now' },
        { action: 'dismiss', title: 'Dismiss'     }
      ],
      vibrate: [200, 100, 200],
    });
  }
});
