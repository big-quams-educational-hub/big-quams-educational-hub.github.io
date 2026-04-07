// ═══════════════════════════════════════════════════════
//  BIG QUAMS MEDIA® — Firebase Cloud Messaging SW
//  File: firebase-messaging-sw.js  (root of main repo)
// ═══════════════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// ── PASTE YOUR FIREBASE CONFIG HERE ──
// Get this from Firebase Console → Project Settings → General → Your apps → SDK setup
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCRrp0cGK-hlBy8Ez8blesCsWn3FP7I-lQ",
  authDomain:        "big-quams-media.firebaseapp.com",
  projectId:         "big-quams-media",
  storageBucket:     "big-quams-media.firebasestorage.app",
  messagingSenderId: "383186323859",
  appId:             "1:383186323859:web:826d6b9977cfa947730066"
};

firebase.initializeApp(FIREBASE_CONFIG);
const messaging = firebase.messaging();

// Handle background push messages (when site tab is not open / in background)
messaging.onBackgroundMessage(payload => {
  const { title, body, url, imageUrl } = payload.data || payload.notification || {};
  return self.registration.showNotification(title || 'BIG QUAMS MEDIA®', {
    body:  body  || 'You have a new update!',
    icon:  'https://i.imgur.com/lYJXUyY.jpeg',
    badge: 'https://i.imgur.com/lYJXUyY.jpeg',
    image: imageUrl || undefined,
    tag:   'bqm-fcm',
    renotify: true,
    data: { url: url || 'https://big-quams-educational-hub.github.io' }
  });
});

// Handle notification click
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url)
    || 'https://big-quams-educational-hub.github.io';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('big-quams-educational-hub') && 'focus' in c) {
          c.navigate(url); return c.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
