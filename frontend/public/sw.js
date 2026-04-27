// JEDCO No-Show App – Service Worker
// Caches the flights list for offline lookup; uses network-first for everything else.
// Also handles Web Share Target POSTs from CamScanner / Photos / etc.

const CACHE_NAME    = 'noshow-v2';
const FLIGHTS_CACHE = 'flights-v1';
const SHARE_CACHE   = 'shared-files-v1';

const SHELL_ASSETS = ['/', '/index.html'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== FLIGHTS_CACHE && k !== SHARE_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

async function handleShareTarget(request) {
  const formData = await request.formData();
  const files    = formData.getAll('files').filter(f => f && f.name);

  const cache = await caches.open(SHARE_CACHE);
  // Clear any previously shared files
  const oldKeys = await cache.keys();
  for (const k of oldKeys) await cache.delete(k);

  const manifest = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const buf  = await file.arrayBuffer();
    const blob = new Blob([buf], { type: file.type || 'application/octet-stream' });
    const url  = `/__share__/${i}/${encodeURIComponent(file.name)}`;
    await cache.put(
      new Request(url),
      new Response(blob, { headers: { 'Content-Type': blob.type } })
    );
    manifest.push({ index: i, name: file.name, type: blob.type, size: file.size, url });
  }

  await cache.put(
    new Request('/__share__/manifest'),
    new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } })
  );

  return Response.redirect('/share-pick', 303);
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Web Share Target receiver
  if (url.pathname === '/share-target' && request.method === 'POST') {
    event.respondWith(handleShareTarget(request));
    return;
  }

  // Serve stored shared files
  if (url.pathname.startsWith('/__share__/')) {
    event.respondWith(
      caches.open(SHARE_CACHE).then(cache => cache.match(request).then(r => r || new Response('', { status: 404 })))
    );
    return;
  }

  // Flights API → Cache-first (offline lookup)
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

  // Other API → Network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => new Response('{"error":"offline"}', {
      headers: { 'Content-Type': 'application/json' },
    })));
    return;
  }

  // Static assets → Cache-first
  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
