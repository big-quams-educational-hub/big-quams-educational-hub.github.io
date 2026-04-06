// ═══════════════════════════════════════════════
//  BIG QUAMS MEDIA® — Service Worker v4
//  Self-polling notifications — no push server needed
// ═══════════════════════════════════════════════

const CACHE_NAME  = 'bqm-v4';
const STORE_NAME  = 'bqm-store';
const SITE_ORIGIN = 'https://big-quams-educational-hub.github.io';
const ICON        = 'https://i.imgur.com/lYJXUyY.jpeg';

// Pages to pre-cache
const PAGES = [
  '/', '/index.html', '/newsroom.html',
  '/elibrary.html', '/dyk.html', '/spotlight.html'
];

// ── INSTALL ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(PAGES).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== STORE_NAME)
            .map(k => caches.delete(k))
      ))
      .then(() => {
        self.clients.claim();
        // Start polling loop after activation
        startPolling();
      })
  );
});

// ── FETCH (Cache strategy) ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // JSON: network first, cache fallback
  if (url.pathname.endsWith('.json')) {
    e.respondWith(
      fetch(e.request)
        .then(res => { cacheResponse(e.request, res.clone()); return res; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // HTML/assets: cache first, network fallback
  e.respondWith(
    caches.match(e.request)
      .then(cached => cached || fetch(e.request)
        .then(res => { cacheResponse(e.request, res.clone()); return res; })
      )
      .catch(() => caches.match('/index.html'))
  );
});

function cacheResponse(req, res) {
  caches.open(CACHE_NAME).then(c => c.put(req, res)).catch(() => {});
}

// ═══════════════════════════════════════════════
//  PERSISTENT KEY-VALUE STORE (Cache API)
//  SW cannot use localStorage — uses Cache API instead
// ═══════════════════════════════════════════════
async function storeGet(key) {
  try {
    const c = await caches.open(STORE_NAME);
    const r = await c.match('/__kv__/' + key);
    return r ? await r.text() : null;
  } catch { return null; }
}
async function storeSet(key, value) {
  try {
    const c = await caches.open(STORE_NAME);
    await c.put(
      '/__kv__/' + key,
      new Response(String(value), { headers: { 'Content-Type': 'text/plain' } })
    );
  } catch {}
}

// ═══════════════════════════════════════════════
//  SELF-POLLING LOOP
//  Every 60 seconds, fetch JSON and compare counts.
//  This runs inside the SW — works even when the
//  site tab is closed, as long as the SW is alive.
//  SW stays alive as long as at least one tab of
//  the site is open. On Chrome Android, it can
//  survive in background for several hours.
// ═══════════════════════════════════════════════
const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds
let pollingTimer = null;

function startPolling() {
  if (pollingTimer) return; // Already running
  scheduleNextPoll();
}

function scheduleNextPoll() {
  pollingTimer = setTimeout(async () => {
    pollingTimer = null;
    await checkForNewContent();
    scheduleNextPoll(); // Chain next poll
  }, POLL_INTERVAL_MS);
}

async function checkForNewContent() {
  try {
    // Fetch both JSON files fresh (bypass cache)
    const ts = Date.now();
    const [newsRes, booksRes] = await Promise.all([
      fetch(SITE_ORIGIN + '/news.json?_=' + ts, { cache: 'no-store' }),
      fetch(SITE_ORIGIN + '/books.json?_=' + ts, { cache: 'no-store' })
    ]);

    if (!newsRes.ok && !booksRes.ok) return;

    const [news, books] = await Promise.all([
      newsRes.ok  ? newsRes.json()  : Promise.resolve([]),
      booksRes.ok ? booksRes.json() : Promise.resolve([])
    ]);

    const prevNews  = parseInt((await storeGet('news_count'))  || '0');
    const prevBooks = parseInt((await storeGet('books_count')) || '0');

    // Save new counts
    if (news.length)  await storeSet('news_count',  String(news.length));
    if (books.length) await storeSet('books_count', String(books.length));

    // Notify only if baseline exists (prevX > 0) and count increased
    const notifEnabled = await storeGet('notif_enabled');
    if (notifEnabled !== '1') return;

    if (prevNews > 0 && news.length > prevNews) {
      const item = news[0]; // newest is first (admin prepends)
      await pushNotif(
        '📰 New Update — Big Quams Media®',
        item.title + (item.summary ? '\n' + item.summary.slice(0, 100) : ''),
        '/newsroom.html',
        'bqm-news-update'
      );
    }

    if (prevBooks > 0 && books.length > prevBooks) {
      const item = books[0];
      await pushNotif(
        '📚 New Book — Big Quams Media® eLibrary',
        item.title + (item.author ? ' · by ' + item.author : ''),
        '/elibrary.html',
        'bqm-book-update'
      );
    }

  } catch { /* SW must never crash — swallow all errors */ }
}

async function pushNotif(title, body, url, tag) {
  if (self.registration.showNotification) {
    return self.registration.showNotification(title, {
      body,
      icon: ICON,
      badge: ICON,
      tag,
      renotify: true,
      requireInteraction: false,
      data: { url: SITE_ORIGIN + url }
    });
  }
}

// ── PERIODIC SYNC (Chrome Android — bonus trigger) ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'bqm-check') e.waitUntil(checkForNewContent());
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'close') return;
  const url = (e.notification.data && e.notification.data.url) || SITE_ORIGIN;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        // Focus existing tab if open
        for (const c of list) {
          if (c.url.startsWith(SITE_ORIGIN)) {
            c.navigate(url);
            return c.focus();
          }
        }
        // Otherwise open new tab
        return clients.openWindow(url);
      })
  );
});

// ── MESSAGE HANDLER ──
// Messages from the page to the SW
self.addEventListener('message', e => {
  if (!e.data) return;
  const msg = e.data;

  // Welcome notification (sent immediately after enabling)
  if (msg.type === 'WELCOME') {
    e.waitUntil(pushNotif(
      msg.title || '🎓 Big Quams Media® — Notifications On!',
      msg.body  || 'Thanks for subscribing! You will receive news updates, new books, scholarship alerts and campus information. Stay tuned!',
      '/',
      'bqm-welcome'
    ));
    return;
  }

  // Set baseline counts when user enables notifications
  if (msg.type === 'SET_BASELINE') {
    e.waitUntil(Promise.all([
      storeSet('notif_enabled', '1'),
      storeSet('news_count',    String(msg.newsCount  || 0)),
      storeSet('books_count',   String(msg.booksCount || 0))
    ]).then(() => {
      // Start polling now that it's enabled
      startPolling();
    }));
    return;
  }

  // Manual check (for debugging or immediate trigger)
  if (msg.type === 'CHECK_NOW' || msg === 'CHECK_UPDATES') {
    e.waitUntil(checkForNewContent());
    return;
  }
});
