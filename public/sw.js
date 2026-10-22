// Service worker: offline app shell + cross-origin isolation for static hosting.
// Model weights are cached separately by Transformers.js (Cache Storage "transformers-cache").
const CACHE = 'playit-v2';
// How long to wait for the network before falling back to the cached app shell.
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('playit-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })()
  )
);

// Static hosts (GitHub Pages etc.) can't send COOP/COEP headers, which multi-threaded WASM
// needs, so add them here. "credentialless" still allows fetching models from Hugging Face.
function isolate(res) {
  if (res.type !== 'basic' && res.type !== 'default') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;

  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(e.request, { ignoreSearch: true });
      // Vendor files (libraries, dictionary) only change with a new build: cache-first.
      if (cached && url.pathname.includes('/vendor/')) return isolate(cached);

      // App files: network-first so updates show up immediately, with a quick fallback
      // to the cache when offline or on a slow connection.
      const network = fetch(e.request).then((res) => {
        if (res.ok) e.waitUntil(cache.put(e.request, res.clone()));
        return res;
      });
      try {
        const res = cached
          ? await Promise.race([network, new Promise((_, reject) => setTimeout(reject, NETWORK_TIMEOUT_MS))])
          : await network;
        return isolate(res);
      } catch {
        if (cached) return isolate(cached);
        return Response.error();
      }
    })()
  );
});
