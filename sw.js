const CACHE = 'bqm-v2';
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
  e.respondWith(caches.match(e.request).then(cached=>{const net=fetch(e.request).then(res=>{const c=res.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c));return res;});return cached||net;}).catch(()=>caches.match('/index.html')));
});

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', e => {
  let data = {title:'BIG QUAMS MEDIA\u00ae',body:'New update available!',url:'/'};
  try { data = {...data,...e.data.json()}; } catch {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: 'https://i.imgur.com/lYJXUyY.jpeg',
    badge: 'https://i.imgur.com/lYJXUyY.jpeg',
    tag: 'bqm-update', renotify: true,
    data: {url: data.url||'/'},
    actions: [{action:'open',title:'Read Now'},{action:'close',title:'Dismiss'}]
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'close') return;
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({type:'window'}).then(list=>{
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});

// ── CHECK FOR NEW CONTENT (triggered by admin after publishing) ──
async function checkForUpdates() {
  try {
    const [newsRes, booksRes] = await Promise.all([fetch('/news.json?v='+Date.now()), fetch('/books.json?v='+Date.now())]);
    const [news, books] = await Promise.all([newsRes.json(), booksRes.json()]);
    const prevNews  = parseInt(await getStore('news_count')  || '0');
    const prevBooks = parseInt(await getStore('books_count') || '0');
    if (news.length > prevNews && prevNews > 0) {
      const n = news[0];
      self.registration.showNotification('📰 New Article — Big Quams Media\u00ae', {
        body: n.title + (n.summary ? ' · ' + n.summary.slice(0,80) : ''),
        icon: 'https://i.imgur.com/lYJXUyY.jpeg', badge: 'https://i.imgur.com/lYJXUyY.jpeg',
        tag: 'bqm-news', data: {url:'/newsroom.html'}
      });
    }
    if (books.length > prevBooks && prevBooks > 0) {
      const b = books[0];
      self.registration.showNotification('📚 New Book in eLibrary — Big Quams Media\u00ae', {
        body: b.title + (b.author ? ' by ' + b.author : ''),
        icon: 'https://i.imgur.com/lYJXUyY.jpeg', badge: 'https://i.imgur.com/lYJXUyY.jpeg',
        tag: 'bqm-books', data: {url:'/elibrary.html'}
      });
    }
    await setStore('news_count', String(news.length));
    await setStore('books_count', String(books.length));
  } catch {}
}

async function getStore(key) {
  try { const c = await caches.open('bqm-store'); const r = await c.match('/__s/'+key); return r ? r.text() : null; } catch { return null; }
}
async function setStore(key, val) {
  try { const c = await caches.open('bqm-store'); await c.put('/__s/'+key, new Response(val)); } catch {}
}

self.addEventListener('message', e => { if (e.data === 'CHECK_UPDATES') checkForUpdates(); });
self.addEventListener('periodicsync', e => { if (e.tag === 'check-updates') e.waitUntil(checkForUpdates()); });
    
