// Service worker: caches the app shell for fast loads; data always comes live from Firestore.
const CACHE = 'almaster-hr-v11';
const SHELL = ['./', './index.html', './app.html', './reset.html', './assets/css/app.css', './assets/img/logo-white.png', './assets/img/logo-full.png', './assets/img/logo-mark-white.png', './assets/img/icon-192.png', './manifest.json'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Firebase & CDNs go straight to the network
  // network first, cache as fallback. 'no-cache' asks the server every time (a cheap "not modified" when
  // nothing changed), so a new release is picked up at once instead of after the browser cache expires.
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('./app.html'))));
});
