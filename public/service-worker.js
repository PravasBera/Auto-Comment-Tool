/* /public/service-worker.js
   PWA cache for FB Auto Comment Tool
   - Caches UI assets for offline launch
   - Never caches SSE (/events) or API POSTs
*/

const CACHE_NAME = 'fbtool-cache-v1';
const CORE_ASSETS = [
  '/',                 // index.html (network-first below)
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// --- Install: pre-cache core static files (except "/")
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(CORE_ASSETS.filter(u => u !== '/')) // don't pre-cache "/"
    )
  );
  self.skipWaiting();
});

// --- Activate: cleanup old caches ---
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(k => (k === CACHE_NAME ? Promise.resolve() : caches.delete(k)))
      )
    )
  );
  self.clients.claim();
});

// --- Helpers ---
const isApi = (url) =>
  url.pathname.startsWith('/events') ||   // SSE
  url.pathname.startsWith('/start')  ||
  url.pathname.startsWith('/stop')   ||
  url.pathname.startsWith('/upload') ||
  url.pathname.startsWith('/admin')  ||
  url.pathname.startsWith('/api')    ||
  url.pathname.startsWith('/user');

const isHtml = (req) =>
  req.mode === 'navigate' ||
  (req.headers.get('accept') || '').includes('text/html');

// --- Fetch strategy ---
// 1) API/SSE: bypass cache (network only)
// 2) HTML pages: network-first, fallback to cache
// 3) Static assets: stale-while-revalidate
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin
  if (url.origin !== self.location.origin) return;

  // Do NOT cache SSE or API endpoints
  if (isApi(url)) return;

  // --- HTML: network-first ---
  if (isHtml(req)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req) || caches.match('/index.html'))
    );
    return;
  }

  // --- Static assets: stale-while-revalidate ---
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => cached); // if offline & network fail → return cache
      return cached || fetchPromise;
    })
  );
});
