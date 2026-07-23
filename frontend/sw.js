// Cache-first shell caching only — never the API. Deliberately does NOT
// precache an explicit asset list at install time: this app already has a
// manual `?v=` cache-busting convention for every static file (see
// index.html's own comment on it), and hardcoding a second list of exact
// versioned URLs here would just be another place for that list to go
// stale. Instead, this caches whatever same-origin GET requests actually
// happen at runtime, the first time each one is fetched — so it can never
// drift out of sync with what the app currently references.
const CACHE_NAME = "ironlog-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only the static shell: same-origin GETs. The backend API lives at a
  // different origin entirely (API_BASE_URL in js/config.js) and must never
  // be cached here — food/water/weight data should always be fresh, and
  // this keeps the service worker completely out of that request path.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline and never cached — let the failure surface naturally
    })
  );
});
