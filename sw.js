const BITFORGE_PWA_CACHE_V1 = 'bitforge-80-pwa-v1';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './styles/chassis.css',
  './styles/pixel-optics.css',
  './src/main.js',
  './src/vault/cookie-vault-head.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

function isSameOriginGet(request) {
  if (!request || request.method !== 'GET') return false;
  if (!self.location || !self.location.origin) return true;
  try {
    const base = self.location.href || self.location.origin;
    const url = new URL(request.url, base);
    return url.origin === self.location.origin;
  } catch {
    return false;
  }
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const copy = typeof res.clone === 'function' ? res.clone() : res;
      try {
        const cache = await caches.open(BITFORGE_PWA_CACHE_V1);
        await cache.put(request, copy);
      } catch {
        // Ignore transient cache write errors so live network response still succeeds.
      }
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    if (request.mode === 'navigate') {
      const indexFallback = (await caches.match('./index.html')) || (await caches.match('./'));
      if (indexFallback) return indexFallback;
    }

    return new Response('Offline', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(BITFORGE_PWA_CACHE_V1);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheKeys = await caches.keys();
      await Promise.all(
        cacheKeys
          .filter((key) => key !== BITFORGE_PWA_CACHE_V1)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  if (!isSameOriginGet(event.request)) return;
  event.respondWith(networkFirst(event.request));
});
