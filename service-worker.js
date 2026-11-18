/* SANY service worker: cache only same-origin app shell/assets. Never intercept POST/API. */
const CACHE_VERSION = 'sany-shell-v1.0.0';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './pwa.js',
  './manifest.json',
  './sany-logo-white.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('sany-shell-') && key !== CACHE_VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // Do not interfere with POST, cross-origin Firebase/CDN, Apps Script, or non-GET requests.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navigation: network first, cached app shell only as a fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put('./index.html', copy));
        }
        return response;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Same-origin static files: network first so deployments are not pinned to stale JS/CSS.
  event.respondWith(
    fetch(request).then(response => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});
