const CACHE_PREFIX = 'clean-manga-reader-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v7`;
const SHELL_ASSETS = [
  '',
  'index.html',
  'reader.html',
  'style.css?v=4.13',
  'config.js?v=4.18',
  'app.js?v=4.23',
  'favicon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL_ASSETS.map(async asset => {
      const url = new URL(asset, self.registration.scope);
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) await cache.put(url, response);
      } catch (error) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const scope = new URL(self.registration.scope);
  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== scope.origin || !requestUrl.pathname.startsWith(scope.pathname)) return;

  event.respondWith((async () => {
    const isNavigation = request.mode === 'navigate';
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = isNavigation
      ? new URL(requestUrl.pathname, requestUrl.origin)
      : request;

    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(cacheKey, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(cacheKey) ||
        (!isNavigation ? await cache.match(cacheKey, { ignoreSearch: true }) : null);
      if (cached) return cached;
      if (isNavigation) {
        const fallback = await cache.match(new URL('index.html', self.registration.scope));
        if (fallback) return fallback;
      }
      return new Response('ออฟไลน์: ไฟล์นี้ยังไม่เคยบันทึกไว้ในเครื่อง', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
