const CACHE = 'bqm-v3';
const ASSETS = ['/', '/index.html', '/newsroom.html', '/elibrary.html', '/dyk.html', '/spotlight.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.endsWith('.json')) {
    e.respondWith(fetch(e.request).then(res=>{const c=res.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c));return res;}).catch(()=>caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(cached=>{
    const net=fetch(e.request).then(res=>{const c=res.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c));return res;});
    return cached||net;
  }).catch(()=>caches.match('/index.html')));
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'close') return;
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for (const c of list) {
      if (c.url.includes(self.location.origin) && 'focus' in c) {
        c.navigate(url); return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});

// ── STORE (Cache API persistence for SW context) ──
async function getStore(key) {
  try {
    const c = await caches.open('bqm-store');
    const r = await c.match('/__bqm__/' + key);
    return r ? await r.text() : null;
  } catch { return null; }
}
async function setStore(key, val) {
  try {
    const c = await caches.open('bqm-store');
    await c.put('/__bqm__/' + key, new Response(String(val), {headers:{'Content-Type':'text/plain'}}));
  } catch {}
}

// ── SHOW NOTIFICATION ──
async function showNotif(title, body, url, tag) {
  return self.registration.showNotification(title, {
    body, tag, renotify: true,
    icon: 'https://i.imgur.com/lYJXUyY.jpeg',
    badge: 'https://i.imgur.com/lYJXUyY.jpeg',
    data: { url: url || '/' },
    requireInteraction: false
  });
}

// ── CHECK FOR NEW CONTENT ──
// Called both from message event (page trigger) and periodicsync
async function checkForUpdates() {
  try {
    const baseUrl = self.location.origin + '/';
    const [newsRes, booksRes] = await Promise.all([
      fetch(baseUrl + 'news.json?v=' + Date.now()),
      fetch(baseUrl + 'books.json?v=' + Date.now())
    ]);
    if (!newsRes.ok || !booksRes.ok) return;
    const [news, books] = await Promise.all([newsRes.json(), booksRes.json()]);

    const prevNews  = parseInt(await getStore('news_count')  || '0');
    const prevBooks = parseInt(await getStore('books_count') || '0');

    // Always update counts — first time sets baseline
    await setStore('news_count', String(news.length));
    await setStore('books_count', String(books.length));

    // Only notify if we had a baseline AND there are new items
    if (prevNews > 0 && news.length > prevNews) {
      const newest = news[0];
      await showNotif(
        '📰 New Article — Big Quams Media®',
        newest.title + (newest.summary ? '\n' + newest.summary.slice(0, 100) : ''),
        '/newsroom.html', 'bqm-news'
      );
    }
    if (prevBooks > 0 && books.length > prevBooks) {
      const newest = books[0];
      await showNotif(
        '📚 New Book Added — Big Quams Media® eLibrary',
        newest.title + (newest.author ? ' · by ' + newest.author : ''),
        '/elibrary.html', 'bqm-books'
      );
    }
  } catch(e) {
    // Silently handle — SW must never crash
  }
}

// ── MESSAGE HANDLER ──
// Page sends messages here: SHOW_NOTIFICATION, CHECK_UPDATES, SET_COUNTS
self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'SHOW_NOTIFICATION') {
    e.waitUntil(showNotif(
      e.data.title || 'BIG QUAMS MEDIA®',
      e.data.body  || 'You have a new update!',
      e.data.url   || '/',
      'bqm-system'
    ));
    return;
  }

  if (e.data.type === 'SET_COUNTS') {
    // Called from page after enabling notifications to set baseline
    e.waitUntil(Promise.all([
      setStore('news_count',  String(e.data.newsCount  || 0)),
      setStore('books_count', String(e.data.booksCount || 0))
    ]));
    return;
  }

  if (e.data === 'CHECK_UPDATES' || e.data.type === 'CHECK_UPDATES') {
    e.waitUntil(checkForUpdates());
    return;
  }
});

// ── PERIODIC BACKGROUND SYNC (Chrome Android only, bonus) ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'check-updates') e.waitUntil(checkForUpdates());
});
