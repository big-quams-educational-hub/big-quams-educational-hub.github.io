// BIG QUAMS MEDIA® Service Worker v8 — Firebase Cloud Messaging
// Handles: offline caching + FCM push notifications

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyCRrp0cGK-hlBy8Ez8blesCsWn3FP7I-lQ',
  authDomain:        'big-quams-media.firebaseapp.com',
  projectId:         'big-quams-media',
  storageBucket:     'big-quams-media.firebasestorage.app',
  messagingSenderId: '383186323859',
  appId:             '1:383186323859:web:826d6b9977cfa947730066'
});

const messaging = firebase.messaging();

const CACHE_NAME = 'bqm-static-v9';
const BQM_DOMAIN = 'https://bigquamsmedia.com.ng';
const BQM_ICON   = 'https://bigquamsmedia.com.ng/logo.png';
const BQM_BADGE  = 'https://bigquamsmedia.com.ng/logo.png';

const STATIC_ASSETS = [
  '/','/index.html','/explore.html','/newsroom.html','/elibrary.html',
  '/dyk.html','/spotlight.html','/results.html','/postutme-calculator.html',
  '/postutme-prep.html','/cbt.html','/scholarship.html','/subject-combo.html',
  '/community.html','/gpa-calculator.html','/student-loan.html','/manifest.json',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(STATIC_ASSETS.map(url => cache.add(url).catch(() => {})))
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.hostname.includes('firebaseapp.com') || url.hostname.includes('googleapis.com') ||
      url.hostname.includes('firebasestorage.app') || url.hostname.includes('gstatic.com') ||
      url.hostname.includes('firebaseio.com') || url.hostname.includes('firebase.com')) return;
  if (url.origin !== location.origin &&
      !url.hostname.includes('fonts.googleapis.com') &&
      !url.hostname.includes('fonts.gstatic.com')) return;
  if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname === '') {
    event.respondWith(networkFirst(request)); return;
  }
  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) { const cache = await caches.open(CACHE_NAME); cache.put(request, response.clone()); }
    return response;
  } catch { return new Response('Offline', { status: 503 }); }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) { const cache = await caches.open(CACHE_NAME); cache.put(request, response.clone()); }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('<h1>You are offline</h1>', { status: 503, headers: { 'Content-Type': 'text/html' } });
  }
}

// FCM BACKGROUND MESSAGE
messaging.onBackgroundMessage(payload => {
  const data  = payload.data || {};
  const notif = payload.notification || {};
  const title = data.title || notif.title || 'Big Quams Media®';
  const body  = data.body  || notif.body  || 'You have a new update!';
  const icon  = BQM_ICON;   // Always use our short URL — never trust payload icon
  const badge = BQM_BADGE;
  const url   = data.url   || BQM_DOMAIN + '/';
  const tag   = data.tag   || 'bqm-update';

  return self.registration.showNotification(title, {
    body, icon, badge, tag,
    renotify: true,
    data: { url },
    actions: [
      { action: 'open',    title: '👀 View Now' },
      { action: 'dismiss', title: 'Dismiss'     }
    ],
    vibrate: [200, 100, 200],
  });
});

// NOTIFICATION CLICK
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const targetUrl = event.notification.data?.url || BQM_DOMAIN + '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('bigquamsmedia.com.ng') && 'focus' in client) {
          client.navigate(targetUrl); return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// MESSAGES FROM PAGE
self.addEventListener('message', event => {
  if (event.data?.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(event.data.title || 'Big Quams Media®', {
      body: event.data.body || 'New update!', icon: BQM_ICON, badge: BQM_BADGE,
      tag: 'bqm-manual', data: { url: event.data.url || BQM_DOMAIN + '/' }
    });
  }
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'BROADCAST_NOTIFICATION') {
    const { title, body, url, tag } = event.data;
    self.registration.showNotification(title || 'Big Quams Media®', {
      body: body || 'New update!', icon: BQM_ICON, badge: BQM_BADGE,
      tag: tag || 'bqm-broadcast', renotify: true,
      data: { url: url || BQM_DOMAIN + '/' },
      actions: [{ action: 'open', title: '👀 View Now' }, { action: 'dismiss', title: 'Dismiss' }],
      vibrate: [200, 100, 200],
    });
  }
});
