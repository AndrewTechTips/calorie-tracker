// Cache-first shell caching only — never the API. Deliberately does NOT
// precache an explicit asset list at install time: this app already has a
// manual `?v=` cache-busting convention for every static file (see
// index.html's own comment on it), and hardcoding a second list of exact
// versioned URLs here would just be another place for that list to go
// stale. Instead, this caches whatever same-origin GET requests actually
// happen at runtime, the first time each one is fetched — so it can never
// drift out of sync with what the app currently references.
// Bumped to v2 alongside the network-first-for-unversioned-URLs fix below —
// forces every existing install to drop whatever stale index.html it had
// cached under the old cache-first behavior (see activate()'s cleanup)
// instead of that one bad entry lingering under the same cache name forever.
const CACHE_NAME = "ironlog-shell-v2";

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

  // Every static asset this app owns carries a `?v=...` cache-busting query
  // string (see index.html's own comment on the convention) — so a URL that
  // HAS one is immutable and safe to serve cache-first forever (a content
  // change always means a new URL). A URL WITHOUT one is exactly the entry
  // points that convention can't version — index.html itself, `/`,
  // manifest.json — and those must always be network-first. Cache-first on
  // index.html was the actual bug behind "I still see the old version after
  // a push, even minutes later, until I hard-refresh": once cached, it kept
  // being served forever, still pointing at whatever `?v=` asset URLs were
  // current the first time it was ever fetched — so no deploy could ever
  // reach a returning visitor's tab without a hard refresh, no matter how
  // many times the JS/CSS underneath it changed.
  if (!url.search.includes("v=")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request)) // offline fallback to whatever shell was last cached
    );
    return;
  }

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
