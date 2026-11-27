// Zero-dependency offline app-shell Service Worker for the standalone mPlay3r Web/PWA build.
// Intentionally skips range requests, audio files, blob:/mplay3r: URLs, and cross-origin traffic.

const CACHE_NAME = 'mplay3r-shell-v1';
const SHELL_ASSETS = ['/', '/css/minimal.css', '/css/app.css', '/manifest.webmanifest', '/icons/icon.svg'];
const AUDIO_EXT_RE = /\.(?:mp3|flac|wav|ogg|oga|opus|m4a|aac|webm|weba)$/i;

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !/^https?:$/.test(url.protocol)) {
    return;
  }

  if (AUDIO_EXT_RE.test(url.pathname)) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('/'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request)
        .then(response => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
