// JEDCO No-Show App – Service Worker
// Caches the flights list for offline lookup; uses network-first for everything else.

const CACHE_NAME = 'noshow-v1';
const FLIGHTS_CACHE = 'flights-v1';

const SHELL_ASSETS = ['/', '/index.html'];

// ── Install: pre-cache shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== FLIGHTS_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch strategy
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Flights API → Cache-first (enables offline lookup)
  if (url.pathname.startsWith('/api/flights')) {
    event.respondWith(
      caches.open(FLIGHTS_CACHE).then(async cache => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Other API calls → Network-first, no cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => new Response('{"error":"offline"}', {
      headers: { 'Content-Type': 'application/json' },
    })));
    return;
  }

  // App shell / static assets → Cache-first
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
