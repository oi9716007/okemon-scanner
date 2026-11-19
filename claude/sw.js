// Okemon Scanner service worker: az app-héj offline is indul; API-hívások mindig hálózatról.
const V = 'okemon-claude-v6';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'js/app.js', 'js/db.js', 'js/api.js', 'js/recognize.js', 'js/packinfo.js', 'js/products.js', 'js/imageindex.js', 'js/identify.js', 'js/completeness.js', 'js/catalog.js', 'js/history.js', 'js/live.js', 'js/detect-core.js', 'js/detect-worker.js', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('okemon-claude-v') && k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) { // hálózat először, cache tartalék (így a frissítések azonnal látszanak)
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  // lapképek és OCR-motor/nyelvi adatok: cache először
  if (/assets\.tcgdex\.net|images\.scrydex\.com|images\.pokemontcg\.io|cdn\.jsdelivr\.net|tessdata|cdn\.shopify\.com/.test(u.host + u.pathname)) {
    const bucket = /jsdelivr|tessdata/.test(u.host + u.pathname) ? 'okemon-ocr' : 'okemon-img';
    e.respondWith(caches.open(bucket).then(c => c.match(e.request).then(m => m || fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }))));
  }
});
