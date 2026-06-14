/**
 * Service Worker for whisper-webCLI
 * 
 * Responsibilities:
 * - Cache static assets (HTML, CSS, JS) for offline access
 * - Cache the whisper.cpp WASM binary
 * - Re-attach COOP/COEP headers to cached responses (for offline isolation)
 * - Handle network requests with cache-first strategy for assets
 * 
 * Note: Model weights are cached in IndexedDB (model-manager.js),
 * not in the service worker cache, to avoid bloating the service worker storage quota.
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME = `whisper-webCLI-${CACHE_VERSION}`;

// Files to cache on install
const CACHE_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/transcriber.js',
  '/model-manager.js',
  '/format-exporter.js',
  '/transcription-worker.js',
  '/manifest.json',
];

/**
 * Install: Cache static assets
 */
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CACHE_ASSETS).catch((err) => {
        // Warn but don't fail: some assets may not exist yet
        console.warn('Service worker: Some assets not available for caching', err);
      });
    })
  );
});

/**
 * Activate: Clean up old caches
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

/**
 * Fetch: Cache-first strategy for assets, network-first for APIs
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip external CDN requests and model downloads (handled by app)
  if (!url.origin.includes(self.location.origin)) {
    // For external model downloads, use network-only
    // (app handles caching to IndexedDB)
    event.respondWith(
      fetch(request).catch(() => {
        return new Response('Offline - model download not available', {
          status: 503,
        });
      })
    );
    return;
  }

  // For local assets: network-first so the latest code always loads when
  // online, falling back to the cache when offline. This avoids serving stale
  // JS during development while preserving offline capability.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (!response || response.status !== 200) {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          try {
            if (
              request.url.startsWith('http://') ||
              request.url.startsWith('https://')
            ) {
              cache.put(request, responseToCache);
            }
          } catch (err) {
            console.warn('Service worker: Failed to cache request', request.url, err);
          }
        });
        return attachIsolationHeaders(response);
      })
      .catch(() =>
        caches.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            return attachIsolationHeaders(cachedResponse);
          }
          return new Response('Offline and not cached', { status: 503 });
        })
      )
  );
});

/**
 * Attach COOP/COEP headers to responses for offline cross-origin isolation.
 */
function attachIsolationHeaders(response) {
  // Create a new response with isolation headers
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
  newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
  newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// Message handler for app-to-SW communication
self.addEventListener('message', (event) => {
  const { type } = event.data;

  if (type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.ports[0].postMessage({ success: true });
    });
  }
});
