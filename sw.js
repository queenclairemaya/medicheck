// ================================================================
//  MediCheck — Service Worker
//  sw.js  (place in your project ROOT, same level as index.html)
//  Handles offline caching so the app works without internet.
// ================================================================

const CACHE_NAME   = 'medicheck-v1';
const DRUG_CACHE   = 'medicheck-drugs-v1';   // cached verify results

// Files to pre-cache on install (app shell)
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// ── Install: cache the app shell ──────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_ASSETS).catch(err => {
        console.warn('[SW] Some shell assets failed to cache:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ─────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== DRUG_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: serve from cache, fall back to network ─────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API requests: network-first, cache verify results for offline
  if (url.pathname.includes('/api/')) {
    // Only cache drug verify responses (GET or POST with action=verify)
    const isVerify =
      (url.searchParams.get('action') === 'verify') ||
      event.request.method === 'POST';   // we'll filter below

    if (url.pathname.includes('drugs.php') && url.searchParams.get('action') === 'verify') {
      event.respondWith(networkFirstWithCache(event.request, DRUG_CACHE));
    } else {
      // All other API calls: network only (auth, register, etc.)
      event.respondWith(networkOnly(event.request));
    }
    return;
  }

  // Static assets + pages: cache-first
  event.respondWith(cacheFirst(event.request));
});

// ── Strategy: cache-first (for static assets) ─────────────────
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
    // Offline and not in cache — return a simple offline page
    return new Response(
      '<h2 style="font-family:sans-serif;text-align:center;padding:40px;color:#6b7280">You\'re offline.<br><a href="/">Reload when connected</a></h2>',
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
}

// ── Strategy: network-first, fall back to cache ───────────────
async function networkFirstWithCache(request, cacheName) {
  try {
    const response = await fetch(request.clone());
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({
        success: false,
        offline: true,
        message: 'You are offline. This drug ID has not been cached previously.',
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ── Strategy: network only (no caching) ───────────────────────
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      JSON.stringify({ success: false, offline: true, message: 'No network connection.' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}
